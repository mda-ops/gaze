import type {ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {ArchitecturePage, InactivityComputationPage, MetricDefinitionsPage} from './InfoPages';

// The fixed-text admin pages against the Python app's captured pages
// (v2/reference, gitignored; skipped without it). Compares the visible text,
// without the table filters that the Python app's app.js adds in the browser.

const CAPTURES = import.meta.glob<string>('../../../reference/2026-10-15/static/*.html', {query: '?raw', import: 'default', eager: true});

function text(html: string): string {
    return html.replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ').trim();
}

function captured(page: string): string {
    const html = CAPTURES[`../../../reference/2026-10-15/static/${page}.html`];
    return text(html.slice(html.indexOf('</header>') + 9, html.indexOf('</main>')));
}

describe.skipIf(!Object.keys(CAPTURES).length)('Info pages match the Python app', () => {
    it.each<[string, () => ReactElement]>([
        ['metric-definitions', MetricDefinitionsPage],
        ['inactivity-computation', InactivityComputationPage],
        ['architecture', ArchitecturePage],
    ])('%s', (page, Page) => {
        const html = renderToStaticMarkup(<Page/>).replace(/<select class="table-filter".*?<\/select>/g, '');
        expect(text(html)).toBe(captured(page));
    });
});
