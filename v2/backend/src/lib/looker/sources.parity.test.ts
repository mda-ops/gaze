import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {readCsv, type Value} from './frame.js';
import {adsData, complianceData, liveLoader, modelSocialsData, ofNewFansData, ticketsData, type Loader, type Table} from './sources.js';

// The Looker source functions against the Python app's, on the same files
// (v2/tools/looker_reference.py; gitignored, skipped without it).

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '..', '..', '..', '..', 'reference', 'looker');
const FILE = path.join(DIR, 'reference.json');

const loader: Loader = {
    snapshot: liveLoader.snapshot,
    async sheet(id) {
        const file = id.startsWith('1y_') ? 'live_marketing_ads.csv' : 'live_of_new_fans.csv';
        return {...readCsv(await fsp.readFile(path.join(DIR, file), 'utf-8')), source: 'Live Google Sheet'};
    },
};

type PyTable = {columns: string[]; rows: Value[][]};

// Rows with equal values in the sorted column are in CPU-dependent order in
// the Python app: compare those in a fixed order.
function canonical(table: PyTable, sortColumn: string | undefined): PyTable {
    if (!sortColumn) return table;
    const at = table.columns.indexOf(sortColumn);
    const rows = [...table.rows].sort((a, b) => (Number(b[at]) - Number(a[at])) || String(a[0]).localeCompare(String(b[0])));
    return {columns: table.columns, rows};
}

// Numbers agree to 1e-9 relative (sums in a different order).
function expectTable(oursTable: Table, theirsTable: PyTable, name: string, sortColumn?: string) {
    const ours = canonical(oursTable, sortColumn);
    const theirs = canonical(theirsTable, sortColumn);
    expect(ours.columns, `${name} columns`).toEqual(theirs.columns);
    expect(ours.rows.length, `${name} rows`).toBe(theirs.rows.length);
    const bad: unknown[] = [];
    ours.rows.forEach((row, i) => row.forEach((v, j) => {
        const t = theirs.rows[i][j];
        const same = typeof v === 'number' && typeof t === 'number' ? Math.abs(v - t) <= 1e-9 * Math.max(1, Math.abs(t)) : v === t;
        if (!same) bad.push([name, i, theirs.columns[j], v, t]);
    }));
    expect(JSON.stringify(bad.slice(0, 10))).toBe("[]");
}

const ref = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf-8')) : null;
const ranges: [string, {start: string; end: string; [fn: string]: unknown}][] = ref ? Object.entries(ref.ranges) : [];

describe.skipIf(!ref)('Looker sources match the Python app', () => {
    it.each(ranges)('%s', async (_, range) => {
        const year = ref.today_year;
        const {start, end} = range;
        const py = range as Record<string, Record<string, unknown>>;

        const compliance = await complianceData(loader, start, end, year);
        expect(compliance.cards).toEqual(py.compliance_data.cards);
        expectTable(compliance.latest, py.compliance_data.latest as PyTable, 'compliance latest');

        const ads = await adsData(loader, start, end, year);
        expect(ads.cards).toEqual(py.ads_data.cards);
        expect([ads.source, ads.latestSourceDate]).toEqual([py.ads_data.source, py.ads_data.latest_source_date]);
        expectTable(ads.byPlatform, py.ads_data.by_platform as PyTable, 'ads by platform', 'ad_spend');
        expectTable(ads.byCampaign, py.ads_data.by_campaign as PyTable, 'ads by campaign', 'ad_spend');
        expectTable(ads.raw, py.ads_data.raw as PyTable, 'ads raw');

        const socials = await modelSocialsData(loader, start, end, year);
        expect(socials.cards).toEqual(py.model_socials_data.cards);
        expectTable(socials.byModel, py.model_socials_data.by_model as PyTable, 'socials by model', 'impressions');
        expectTable(socials.byPlatform, py.model_socials_data.by_platform as PyTable, 'socials by platform', 'impressions');
        expectTable(socials.raw, py.model_socials_data.raw as PyTable, 'socials raw');

        const fans = await ofNewFansData(loader, start, end, year);
        // Top Model and Best Day: any of the rows tied for first.
        const pyFans = py.of_new_fans_data as {cards: string[][]; by_model: PyTable; daily: PyTable};
        expect(fans.cards.filter(c => c[0] !== 'Top Model' && c[0] !== 'Best Day')).toEqual(pyFans.cards.filter(c => c[0] !== 'Top Model' && c[0] !== 'Best Day'));
        const best = (table: Table | PyTable, label: string) => {
            const value = (r: Value[]) => Number(r[1]);
            const max = Math.max(...table.rows.map(value));
            return table.rows.filter(r => value(r) === max).map(r => String(r[0])).includes(label);
        };
        if (pyFans.cards.length) {
            expect(best(fans.byModel, fans.cards[2][1])).toBe(true);
            expect(best(fans.daily, fans.cards[3][1])).toBe(true);
        }
        expectTable(fans.byModel, py.of_new_fans_data.by_model as PyTable, 'fans by model', 'new_fans');
        expectTable(fans.daily, py.of_new_fans_data.daily as PyTable, 'fans daily');
        expectTable(fans.raw, py.of_new_fans_data.raw as PyTable, 'fans raw');

        const tickets = await ticketsData(loader, start, end, year);
        expect(tickets.cards).toEqual(py.tickets_data.cards);
        expect([tickets.source, tickets.latestCreated]).toEqual([py.tickets_data.source, py.tickets_data.latest_created]);
        expectTable(tickets.byStatus, py.tickets_data.by_status as PyTable, 'tickets by status');
        expectTable(tickets.byDepartmentStatus, py.tickets_data.by_department_status as PyTable, 'tickets by department');
        expectTable(tickets.tickets, py.tickets_data.tickets as PyTable, 'tickets');
    });
});
