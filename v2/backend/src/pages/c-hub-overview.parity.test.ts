import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {readCsv} from '../lib/looker/frame.js';
import {liveLoader, type Loader} from '../lib/looker/sources.js';
import {canCompare, captureRateFor, RANGES, refHtml, refPage} from '../test-support/reference.js';
import {cHubOverview} from './c-hub-overview.js';

// /c-hub against the Python app's captured page, with the Google Sheets as
// saved by v2/tools/looker_reference.py.

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

describe.skipIf(!canCompare || !fs.existsSync(DIR))('C Hub overview parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const result = await cHubOverview(getFlowPool(), {
            start, end, compare: 'Previous period', currentYear: 2026, loader, eurUsdRate: captureRateFor(name, '/c-hub'),
        });
        expect(result.cards.map(c => ({label: c.label, value: c.value, note: c.note}))).toEqual(refPage(name, '/c-hub').cards);
        const insights = [...refHtml(name, '/c-hub').matchAll(/<li class='insight-neutral'>(.*?)<\/li>/g)].map(m => unescape(m[1]));
        expect(result.insights).toEqual(insights);
    }, 120_000);
});
