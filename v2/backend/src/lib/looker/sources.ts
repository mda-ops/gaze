import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {IsoDate} from '../period.js';
import {pyFixed} from '../py-format.js';
import {DATE_COLUMNS, parseLookerDate} from './dates.js';
import {cleanNumber, emptyFrame, readCsv, type Frame, type Value} from './frame.js';

// The Python app's Looker sources (app/looker_sources.py): Google Sheets read
// live as CSV, with cached snapshots (backend/data/looker_sources) when a
// sheet cannot be read, and the cached ticket snapshot.

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS = path.join(here, '..', '..', '..', 'data', 'looker_sources');

export const MARKETING_SHEET_ID = '1y_R1cgIc5A4-vFrqY9OC-gQm4NdKJnsCZLn93ONu2ak';
export const MARKETING_ADS_GID = '2065549255';
export const OF_NEW_FANS_SHEET_ID = '14wXRPz6vm9gPE5I0UhlS9Dr7Eopj1JYDK7hm4uiNChY';
export const OF_NEW_FANS_GID = '1377579258';

// Python: SOURCES, shown in the pages' source notes.
export const SOURCES = {
    compliance: {
        title: 'ADG - MD - Project Dusan Dashboard',
        url: 'https://docs.google.com/spreadsheets/d/1D0lnC5q88Q9uRfbaSK3B_yLrskv0EHzQE89pmGqOfJQ/edit?usp=drivesdk',
        tabs: ['ComplianceLooker', 'ComplianceMetric'],
    },
    marketing: {
        title: 'ADG - MD - Marketing Performance Tracker',
        url: 'https://docs.google.com/spreadsheets/d/1y_R1cgIc5A4-vFrqY9OC-gQm4NdKJnsCZLn93ONu2ak/edit?usp=drivesdk',
        tabs: ['MDAds', 'LisaMD', 'LisaModelsRaw', 'OFNewFans'],
    },
    tickets: {
        title: 'ADG - MD - Internal Ticketing - Reporting Hub',
        url: 'https://docs.google.com/spreadsheets/d/1Xa46BD1ypJI3dUfAoVALsE39RYi1j-jsQDzjXujGlAI/edit?usp=drivesdk',
        tabs: ['RAW - Notion Tickets', 'CLEAN - Tickets', 'REPORT - Ticketing KPI'],
    },
} as const;

// A source with where it came from (Python: rows.attrs["source"]).
export interface Source extends Frame {
    source: string;
}

export interface Loader {
    snapshot(file: string): Promise<Source>;
    sheet(spreadsheetId: string, gid: string, fallback: string): Promise<Source>;
}

export const liveLoader: Loader = {
    async snapshot(file) {
        try {
            return {...readCsv(await fs.readFile(path.join(SNAPSHOTS, file), 'utf-8')), source: 'Cached snapshot'};
        } catch {
            return {...emptyFrame(), source: ''};
        }
    },
    async sheet(spreadsheetId, gid, fallback) {
        try {
            const response = await fetch(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`,
                {signal: AbortSignal.timeout(30_000)});
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return {...readCsv(await response.text()), source: 'Live Google Sheet'};
        } catch {
            return this.snapshot(fallback);
        }
    },
};

// A table to show or chart: column names and rows of cells.
export interface Table {
    columns: string[];
    rows: Value[][];
}

export const emptyTable = (): Table => ({columns: [], rows: []});

const toTable = (columns: string[], rows: Record<string, Value>[]): Table => ({columns, rows: rows.map(r => columns.map(c => r[c] ?? null))});

export type Card = [label: string, value: string, note: string];

// Python: parsed_date_series, row by row.
export function rowDates(frame: Frame, currentYear: number): (IsoDate | null)[] {
    const column = DATE_COLUMNS.find(c => frame.columns.includes(c));
    if (!column) return frame.rows.map(() => null);
    const hasYear = frame.columns.includes('Year');
    return frame.rows.map(r => parseLookerDate(r[column], hasYear ? r.Year : undefined, currentYear));
}

// Python: filter_by_date. Rows without a readable date drop out.
export function filterByDate<T extends Frame>(frame: T, start: IsoDate | null, end: IsoDate | null, currentYear: number): T {
    if (!frame.rows.length || start === null || end === null) return frame;
    const dates = rowDates(frame, currentYear);
    return {...frame, rows: frame.rows.filter((_, i) => dates[i] !== null && dates[i]! >= start && dates[i]! <= end)};
}

// Python: numeric_series; a missing column gives missing values (NaN).
const numeric = (frame: Frame, column: string) => (row: Record<string, Value>): number | null =>
    (frame.columns.includes(column) ? cleanNumber(row[column]) : null);

const sum = (values: (number | null)[]) => values.reduce<number>((s, v) => s + (v ?? 0), 0);

// pandas sort_values(descending). Equal values keep their order here; in the
// Python app their order depends on NumPy's unstable, CPU-specific sort.
export function descending<T>(rows: T[], value: (row: T) => number): T[] {
    return [...rows].sort((a, b) => value(b) - value(a));
}

// pandas groupby(key, dropna=False).agg(sum) then sort_values(by, descending):
// keys in code-point order with the missing key last.
function groupSum(rows: Record<string, Value>[], key: string, sums: [string, (row: Record<string, Value>) => number | null][], sortBy: string): Record<string, Value>[] {
    const groups = new Map<string | null, Record<string, Value>>();
    for (const row of rows) {
        const k = row[key] === null || row[key] === undefined ? null : String(row[key]);
        let g = groups.get(k);
        if (!g) {
            g = {[key]: k, ...Object.fromEntries(sums.map(([name]) => [name, 0]))};
            groups.set(k, g);
        }
        for (const [name, value] of sums) g[name] = (g[name] as number) + (value(row) ?? 0);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0));
    return descending(keys.map(k => groups.get(k)!), g => g[sortBy] as number);
}

// Python: "%d %b %Y" of a date.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonthYear = (date: IsoDate) => `${date.slice(8, 10)} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;

export interface ComplianceData {
    cards: Card[];
    latest: Table;
    metrics: Table;
}

export async function complianceData(loader: Loader, start: IsoDate | null, end: IsoDate | null, currentYear: number): Promise<ComplianceData> {
    const all = await loader.snapshot('compliance_looker.csv');
    let looker = filterByDate(all, start, end, currentYear);
    const metric = await loader.snapshot('compliance_metric.csv');
    const metrics = toTable(metric.columns, metric.rows);
    // An empty range falls back to every row.
    if (!looker.rows.length && all.rows.length) looker = all;
    if (!looker.rows.length) return {cards: [], latest: toTable(looker.columns, []), metrics};
    const hasDate = looker.columns.includes('Date of Evaluation');
    const labels = looker.rows.map(r => r['Date of Evaluation']).filter(v => v !== null && v !== undefined);
    const latestLabel = hasDate ? labels[labels.length - 1] : 'latest';
    const latest = hasDate ? looker.rows.filter(r => r['Date of Evaluation'] === latestLabel) : looker.rows.slice(-6);
    const mean = (column: string) => {
        const values = latest.map(numeric(looker, column));
        return values.length && values.every(v => v !== null) ? sum(values) / values.length : NaN;
    };
    const pillars = looker.columns.includes('Pillar') ? new Set(latest.map(r => r.Pillar).filter(v => v !== null)).size : 0;
    return {
        cards: [
            ['Latest Evaluation', String(latestLabel), 'Looker source'],
            ['Avg Best Score', pyFixedOrNan(mean('Best Score'), 1), 'latest period'],
            ['Avg Worst Score', pyFixedOrNan(mean('Worst Score'), 1), 'latest period'],
            ['Pillars Tracked', String(pillars), 'quality areas'],
        ],
        latest: toTable(looker.columns, latest),
        metrics,
    };
}

const pyFixedOrNan = (value: number, decimals: number, grouping = false) => (Number.isNaN(value) ? 'nan' : pyFixed(value, decimals, grouping));

export interface AdsData {
    cards: Card[];
    byPlatform: Table;
    byCampaign: Table;
    raw: Table;
    source: string;
    latestSourceDate: string;
}

export async function adsData(loader: Loader, start: IsoDate | null, end: IsoDate | null, currentYear: number): Promise<AdsData> {
    const source = await loader.sheet(MARKETING_SHEET_ID, MARKETING_ADS_GID, 'marketing_ads.csv');
    const dates = rowDates(source, currentYear).filter((d): d is IsoDate => d !== null).sort();
    const latestSourceDate = dates.length ? dayMonthYear(dates[dates.length - 1]) : '';
    const ads = filterByDate(source, start, end, currentYear);
    if (!ads.rows.length) {
        const empty = toTable(ads.columns, []);
        return {cards: [], byPlatform: empty, byCampaign: empty, raw: empty, source: source.source, latestSourceDate};
    }
    const added = ['impressions_num', 'clicks_num', 'spend_num', 'leads_signed_num'];
    const rows = ads.rows.map((r): Record<string, Value> => ({
        ...r,
        impressions_num: numeric(ads, 'Impressions')(r), clicks_num: numeric(ads, 'Link Clicks (Leads)')(r),
        spend_num: numeric(ads, 'Ad Spend')(r), leads_signed_num: numeric(ads, 'Leads Signed')(r),
    }));
    const total = (c: string) => sum(rows.map(r => r[c] as number | null));
    const spend = total('spend_num');
    const clicks = total('clicks_num');
    const signed = total('leads_signed_num');
    const sums: [string, (row: Record<string, Value>) => number | null][] = [
        ['impressions', r => r.impressions_num as number | null], ['clicks', r => r.clicks_num as number | null],
        ['ad_spend', r => r.spend_num as number | null], ['leads_signed', r => r.leads_signed_num as number | null],
    ];
    const group = (key: string) => toTable([key, 'impressions', 'clicks', 'ad_spend', 'leads_signed'],
        ads.columns.includes(key) ? groupSum(rows, key, sums, 'ad_spend') : []);
    return {
        cards: [
            ['Ad Spend', `€${pyFixed(spend, 2)}`, source.source ? source.source.toLowerCase() : 'selected source'],
            ['Impressions', pyFixed(total('impressions_num'), 0), 'total'],
            ['Link Clicks', pyFixed(clicks, 0), 'leads'],
            ['Cost / Click', clicks ? `€${pyFixed(spend / clicks, 2)}` : 'n/a', 'calculated'],
            ['Leads Signed', pyFixed(signed, 0), 'reported'],
        ],
        byPlatform: group('Platform'),
        byCampaign: group('Campaign Name'),
        raw: toTable([...ads.columns, ...added], rows),
        source: source.source,
        latestSourceDate,
    };
}

export interface SocialsData {
    cards: Card[];
    byModel: Table;
    byPlatform: Table;
    raw: Table;
}

const SOCIAL_COLUMNS: [string, string][] = [
    ['Impressions', 'impressions'], ['Profile Visits', 'profile_visits'], ['Followers Gained', 'followers_gained'],
    ['Bio Link Clicks', 'bio_clicks'], ['Bouncy Link Clicks', 'bouncy_clicks'], ['Subscriptions (F2F)', 'subscriptions_f2f'],
    ['Subscriptions (OF)', 'subscriptions_of'], ['Content Planned', 'content_planned'], ['Content Posted', 'content_posted'],
];

export async function modelSocialsData(loader: Loader, start: IsoDate | null, end: IsoDate | null, currentYear: number): Promise<SocialsData> {
    const frame = filterByDate(await loader.snapshot('models_lisa_raw.csv'), start, end, currentYear);
    if (!frame.rows.length) {
        const empty = toTable(frame.columns, []);
        return {cards: [], byModel: empty, byPlatform: empty, raw: empty};
    }
    const rows = frame.rows.map(r => {
        const out: Record<string, Value> = {...r};
        for (const [source, target] of SOCIAL_COLUMNS) out[target] = numeric(frame, source)(r);
        const f2f = out.subscriptions_f2f as number | null;
        const of = out.subscriptions_of as number | null;
        out.subscriptions = f2f === null || of === null ? null : f2f + of;
        return out;
    });
    const total = (c: string) => sum(rows.map(r => r[c] as number | null));
    const pick = (c: string) => (r: Record<string, Value>) => r[c] as number | null;
    const byModel = toTable(['Model', 'impressions', 'profile_visits', 'followers_gained', 'subscriptions', 'content_posted'],
        frame.columns.includes('Model') ? groupSum(rows, 'Model', [['impressions', pick('impressions')], ['profile_visits', pick('profile_visits')],
            ['followers_gained', pick('followers_gained')], ['subscriptions', pick('subscriptions')], ['content_posted', pick('content_posted')]], 'impressions') : []);
    const byPlatform = toTable(['Platform', 'impressions', 'profile_visits', 'followers_gained', 'subscriptions'],
        frame.columns.includes('Platform') ? groupSum(rows, 'Platform', [['impressions', pick('impressions')], ['profile_visits', pick('profile_visits')],
            ['followers_gained', pick('followers_gained')], ['subscriptions', pick('subscriptions')]], 'impressions') : []);
    return {
        cards: [
            ['Impressions', pyFixed(total('impressions'), 0), 'social reach'],
            ['Profile Visits', pyFixed(total('profile_visits'), 0), 'total'],
            ['Followers Gained', pyFixed(total('followers_gained'), 0), 'growth'],
            ['Subscriptions', pyFixed(total('subscriptions'), 0), 'F2F + OF'],
        ],
        byModel,
        byPlatform,
        raw: toTable([...frame.columns, ...SOCIAL_COLUMNS.map(([, t]) => t), 'subscriptions'], rows),
    };
}

export interface FansData {
    cards: Card[];
    byModel: Table;
    daily: Table;
    raw: Table;
}

export async function ofNewFansData(loader: Loader, start: IsoDate | null, end: IsoDate | null, currentYear: number): Promise<FansData> {
    const wide = filterByDate(await loader.sheet(OF_NEW_FANS_SHEET_ID, OF_NEW_FANS_GID, 'of_new_fans.csv'), start, end, currentYear);
    const raw = toTable(wide.columns, wide.rows);
    if (!wide.rows.length || !wide.columns.includes('Date')) return {cards: [], byModel: raw, daily: raw, raw};
    // melt: every model column under each other.
    const long: Record<string, Value>[] = [];
    for (const column of wide.columns.filter(c => c !== 'Date')) {
        for (const row of wide.rows) long.push({Date: row.Date, model: column.trim(), new_fans: cleanNumber(row[column])});
    }
    const byModel = groupSum(long, 'model', [['new_fans', r => r.new_fans as number]], 'new_fans');
    // groupby("Date") without sorting by value.
    const dailyMap = new Map<string | null, number>();
    for (const r of long) {
        const k = r.Date === null ? null : String(r.Date);
        dailyMap.set(k, (dailyMap.get(k) ?? 0) + (r.new_fans as number));
    }
    const daily = [...dailyMap.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0))
        .map(k => ({Date: k, new_fans: dailyMap.get(k)!}));
    const bestDay = descending(daily, d => d.new_fans)[0];
    return {
        cards: [
            ['New Fans', pyFixed(sum(long.map(r => r.new_fans as number)), 0), 'OF total'],
            ['Models Tracked', String(new Set(byModel.map(r => r.model)).size), 'source columns'],
            ['Top Model', String(byModel[0]?.model ?? 'n/a'), 'by new fans'],
            ['Best Day', bestDay ? String(bestDay.Date) : 'n/a', 'highest daily total'],
        ],
        byModel: toTable(['model', 'new_fans'], byModel),
        daily: toTable(['Date', 'new_fans'], daily),
        raw,
    };
}

export interface TicketsData {
    cards: Card[];
    byDepartmentStatus: Table;
    byStatus: Table;
    tickets: Table;
    source: string;
    latestCreated: string;
}

const TICKET_COLUMNS: [string, string[]][] = [
    ['Created', ['Created', 'Created time', 'Created Time', 'Created At', 'Date']],
    ['Ticket Subject', ['Ticket Subject', 'Name', 'Subject', 'Title', 'Task']],
    ['Department', ['Department', 'Responsible Department', 'Team']],
    ['Assignee', ['Assignee', 'Assigned To', 'Owner']],
    ['Urgency', ['Urgency', 'Priority']],
    ['Status', ['Status', 'Ticket Status']],
];

// pd.to_datetime without a format, for the ISO dates of the ticket sources.
function createdDate(value: Value): IsoDate | null {
    if (value === null) return null;
    const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export async function ticketsData(loader: Loader, start: IsoDate | null, end: IsoDate | null, currentYear: number): Promise<TicketsData> {
    // Live Notion tickets are not read yet: the cached snapshot, as the Python
    // app uses without a Notion token.
    const source = await loader.snapshot('notion_tickets.csv');
    const label = source.rows.length ? 'Cached ticket snapshot' : '';
    if (!source.rows.length) {
        return {cards: [], byDepartmentStatus: emptyTable(), byStatus: emptyTable(), tickets: toTable(source.columns, []), source: 'No ticket source connected', latestCreated: ''};
    }
    const normalized = new Map(source.columns.map(c => [c.trim().toLowerCase(), c]));
    const columnFor = (names: string[]) => names.map(n => normalized.get(n.trim().toLowerCase())).find(c => c !== undefined);
    const picked: Frame = {
        columns: TICKET_COLUMNS.map(([name]) => name),
        types: {},
        rows: source.rows.map(r => Object.fromEntries(TICKET_COLUMNS.map(([name, names]) => {
            const column = columnFor(names);
            return [name, column === undefined ? '' : r[column]];
        }))),
    };
    const rows = filterByDate(picked, start, end, currentYear).rows;
    const columns = TICKET_COLUMNS.map(([name]) => name);
    if (!rows.length) {
        return {cards: [], byDepartmentStatus: emptyTable(), byStatus: emptyTable(), tickets: toTable(columns, []), source: label, latestCreated: ''};
    }
    const created = rows.map(r => createdDate(r.Created));
    const latest = created.filter((d): d is IsoDate => d !== null).sort().pop();
    const shortDate = (d: IsoDate) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
    const orDefault = (v: Value, fallback: string) => (v === null || v === '' ? fallback : v);
    const tickets = rows.map((r, i) => ({
        'Created': created[i] ? shortDate(created[i]!) : '',
        'Ticket Subject': orDefault(r['Ticket Subject'], 'Untitled ticket'),
        'Department': orDefault(r.Department, 'Unassigned'),
        'Assignee': orDefault(r.Assignee, 'Unassigned'),
        'Urgency': orDefault(r.Urgency, 'None'),
        'Status': orDefault(r.Status, 'Unknown'),
    }));
    // value_counts: most first; equal counts in order of first appearance.
    const statusCounts = new Map<string, number>();
    for (const t of tickets) statusCounts.set(String(t.Status), (statusCounts.get(String(t.Status)) ?? 0) + 1);
    const byStatus = [...statusCounts.entries()].sort((a, b) => b[1] - a[1]);
    const pairs = new Map<string, {Department: string; Status: string; tickets: number}>();
    for (const t of tickets) {
        const key = JSON.stringify([t.Department, t.Status]);
        const entry = pairs.get(key) ?? {Department: String(t.Department), Status: String(t.Status), tickets: 0};
        entry.tickets += 1;
        pairs.set(key, entry);
    }
    const byDepartmentStatus = [...pairs.values()].sort((a, b) =>
        (a.Department < b.Department ? -1 : a.Department > b.Department ? 1 : 0) || (a.Status < b.Status ? -1 : a.Status > b.Status ? 1 : 0));
    const count = (test: (t: typeof tickets[number]) => boolean) => String(tickets.filter(test).length);
    return {
        cards: [
            ['Total Tickets', String(tickets.length), 'created'],
            ['Unassigned', count(t => t.Assignee === 'Unassigned'), 'needs owner'],
            ['Open', count(t => t.Status === 'New' || t.Status === 'In progress'), 'new + in progress'],
            ['Completed', count(t => t.Status === 'Completed'), 'done'],
            ['Finalized', count(t => t.Status === 'Completed' || t.Status === 'Declined'), 'completed + declined'],
        ],
        byDepartmentStatus: toTable(['Department', 'Status', 'tickets'], byDepartmentStatus),
        byStatus: {columns: ['status', 'tickets'], rows: byStatus.map(([status, n]) => [status, n])},
        tickets: toTable(columns, tickets),
        source: label,
        latestCreated: latest ? shortDate(latest) : '',
    };
}
