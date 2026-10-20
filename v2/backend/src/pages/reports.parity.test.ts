import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {emptyFilters} from '../lib/filters.js';
import {readCsv} from '../lib/looker/frame.js';
import {liveLoader, type Loader} from '../lib/looker/sources.js';
import {canCompare, captureRateFor, RANGES, refHtml} from '../test-support/reference.js';
import {report, type ReportKind} from './reports.js';

// Weekly and monthly reports against the Python app's captured report text.

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '..', '..', '..', 'reference', 'looker');

const loader: Loader = {
    snapshot: liveLoader.snapshot,
    async sheet(id) {
        const file = id.startsWith('1y_') ? 'live_marketing_ads.csv' : 'live_of_new_fans.csv';
        return {...readCsv(await fsp.readFile(path.join(DIR, file), 'utf-8')), source: 'Live Google Sheet'};
    },
};

const unescape = (t: string) => t.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const cases = RANGES.flatMap(([name, start, end]) => (['weekly', 'monthly'] as ReportKind[]).map(kind => [`${name} ${kind}`, name, start, end, kind] as const));

describe.skipIf(!canCompare || !fs.existsSync(DIR))('Report parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(cases)('%s', async (_, name, start, end, kind) => {
        const route = `/${kind}-report`;
        const [summary, text] = [...refHtml(name, route).matchAll(/<pre class='report'>([\s\S]*?)<\/pre>/g)].map(m => unescape(m[1]));
        const result = await report(getFlowPool(), {
            kind, start, end, compare: 'Previous period', filters: emptyFilters(), currentYear: 2026, loader, eurUsdRate: captureRateFor(name, route),
        });
        expect(result.managementSummary).toBe(summary);
        // Rows tied on revenue are in CPU-dependent order in the Python app: a
        // line may differ only in the name, with the same badge, amount and change.
        const ours = result.report.split('\n');
        const theirs = text.split('\n');
        expect(ours.length).toBe(theirs.length);
        const nameless = (line: string) => line.replace(/^(:\w+: )?.*? (€-?[\d,]+)/, '$1$2');
        const different = ours.map((line, i) => [line, theirs[i]]).filter(([o, t]) => o !== t && nameless(o) !== nameless(t));
        expect(different).toEqual([]);
    }, 120_000);
});
