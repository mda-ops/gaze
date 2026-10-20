import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {emptyFilters} from '../lib/filters.js';
import {canCompare, captureRateFor, RANGES, refHtml} from '../test-support/reference.js';
import {insights} from './insights.js';

// /insights against the sentences of the Python app's captured page.

const unescape = (text: string) => text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function section(html: string, title: string): string {
    const start = html.indexOf(`<h2>${title}</h2>`);
    return html.slice(start, html.indexOf('</section>', start));
}

describe.skipIf(!canCompare)('Insights parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const html = refHtml(name, '/insights');
        const facts = [...section(html, 'Deterministic Insights').matchAll(/<li>(.*?)<\/li>/g)].map(m => unescape(m[1]));
        const flags = [...section(html, 'Anomaly Flags').matchAll(/<p><strong>(\w+) - (.*?):<\/strong> (.*?)<br><span>(.*?)<\/span><\/p>/g)]
            .map(m => [m[1], unescape(m[2]), unescape(m[3]), unescape(m[4])]);

        const result = await insights(getFlowPool(), {
            start, end, compare: 'Previous period', filters: emptyFilters(), dropPct: 30, spikePct: 40, eurUsdRate: captureRateFor(name, '/insights'),
        });
        expect(result.facts).toEqual(facts);
        // Rows with equal revenue are in arbitrary order in the Python app.
        const sorted = (rows: string[][]) => rows.map(r => r.join(' | ')).sort();
        expect(sorted(result.flags.map(f => [f.area, f.name, f.message, f.why]))).toEqual(sorted(flags));
        expect(flags.length).toBeGreaterThan(0);
    }, 120_000);
});
