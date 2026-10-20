import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {readCsv} from '../lib/looker/frame.js';
import {liveLoader, type Card, type Loader} from '../lib/looker/sources.js';
import {RANGES, reference, refPage} from '../test-support/reference.js';
import * as looker from './looker.js';

// The Hub and C Hub pages' cards against the Python app's captured pages,
// with the Google Sheets as saved by v2/tools/looker_reference.py.

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '..', '..', '..', 'reference', 'looker');

const loader: Loader = {
    snapshot: liveLoader.snapshot,
    async sheet(id) {
        const file = id.startsWith('1y_') ? 'live_marketing_ads.csv' : 'live_of_new_fans.csv';
        return {...readCsv(await fsp.readFile(path.join(DIR, file), 'utf-8')), source: 'Live Google Sheet'};
    },
};

const PAGES: [string, (input: looker.LookerInput) => Promise<{cards: Card[]}>][] = [
    ['/compliance-dash', looker.complianceDash], ['/marketing', looker.marketing], ['/models-socials', looker.modelsSocials],
    ['/of-new-fan-growth', looker.ofNewFanGrowth], ['/ads-performance', looker.adsPerformance], ['/notion-tickets', looker.notionTickets],
    ['/c-hub/compliance', looker.cHubCompliance], ['/c-hub/marketing-ads', looker.cHubMarketingAds], ['/c-hub/models-socials', looker.cHubModelsSocials],
    ['/c-hub/of-new-fans', looker.cHubOfNewFans], ['/c-hub/ads-performance', looker.cHubAdsPerformance], ['/c-hub/tickets', looker.cHubTickets],
];

const cases = RANGES.flatMap(([name, start, end]) => PAGES.map(([page, build]) => [`${name} ${page}`, name, start, end, page, build] as const));

describe.skipIf(!reference || !fs.existsSync(DIR))('Hub pages match the Python app', () => {
    it.each(cases)('%s', async (_, name, start, end, page, build) => {
        const result = await build({start, end, currentYear: 2026, loader});
        const ref = refPage(name, page);
        // The captured text has runs of spaces collapsed, as a browser shows it.
        const shown = (text: string) => text.replace(/\s+/g, ' ');
        expect(result.cards.map(([label, value, note]) => ({label, value: shown(value), note}))).toEqual(ref.cards);
    });
});
