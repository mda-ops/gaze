import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';

// Access to the Python app's captured numbers (v2/reference/<date>, gitignored:
// real revenue data) for the parity tests. See v2/tools/capture_reference.py.

const here = path.dirname(fileURLToPath(import.meta.url));
const V2 = path.join(here, '..', '..', '..');
dotenv.config({path: path.join(V2, '.env'), quiet: true});

export const CAPTURE = '2026-10-15';
// Days that had settled when the captures were taken: Flow's miner still
// corrected 2026-10-14 afterwards (it removed a EUR 48 F2F transaction), and
// by 2026-10-19 it had also changed 2026-10-10 to 2026-10-13 (one day by
// about EUR 3,800), which the 2026-10-16 re-capture still shows unchanged.
export const SETTLED_BEFORE = '2026-10-10';

export const RANGES: [name: string, start: string, end: string][] = [
    ['2026-09_month', '2026-09-01', '2026-09-30'],
    ['2026-10-02_week', '2026-10-02', '2026-10-08'],
    ['2026-10-01_day', '2026-10-01', '2026-10-01'],
];

export interface RefPage {
    cards: {label: string; value: string; note: string}[];
    tables: {headers: string[]; rows: (string | number | null)[][]}[];
    chart?: {
        trend: {date: string; revenue: number; platforms: {platform: string; revenue: number}[]}[];
        previousMonthTrend: {date: string; revenue: number; platforms: {platform: string; revenue: number}[]}[];
        previousMonthLabel: string;
    };
    platform_totals?: {platform: string; amount: string; share: string}[];
    revenue_cards?: {name: string; head: string; badges: string[]; total: string; subscriptions: string; platforms: {platform: string; amount: string; subs: string}[]}[];
    selects?: Record<string, string[]>;
    tier_matrix?: {months: string[]; rows: [string, [string, string, string][]][]};
}

interface Capture {
    dir: string;
    pages: Record<string, RefPage>;
    // Flow's EUR/USD rate at capture time (USD revenue always uses the current rate).
    rate: number | undefined;
}

function loadCapture(name: string): Capture | null {
    const dir = path.join(V2, 'reference', name);
    const numbers = path.join(dir, 'numbers.json');
    if (!fs.existsSync(numbers)) return null;
    const rateFile = path.join(dir, 'fx-rate.json');
    return {
        dir,
        pages: JSON.parse(fs.readFileSync(numbers, 'utf-8')).pages,
        rate: fs.existsSync(rateFile) ? JSON.parse(fs.readFileSync(rateFile, 'utf-8')).eur_usd_rate : undefined,
    };
}

// 2026-10-15 is the full capture. 2026-10-16 re-captures the 2026-10-01 pages
// that the first capture took after the Python app's database stall (they
// rendered empty or with fallback values); where present it takes precedence.
const captures = [loadCapture('2026-10-16'), loadCapture(CAPTURE)].filter((c): c is Capture => c !== null);

export const reference = captures.length ? captures : null;

export const canCompare = Boolean(reference && process.env.FLOW_DATABASE_URL);

function captureFor(range: string, route: string): {page: RefPage; rate: number | undefined; dir: string} {
    for (const capture of captures) {
        const page = capture.pages[`${range} ${route}`];
        if (page) return {page, rate: capture.rate, dir: capture.dir};
    }
    throw new Error(`No reference for ${range} ${route}`);
}

export function refPage(range: string, route: string): RefPage {
    return captureFor(range, route).page;
}

// The captured HTML of the page that refPage() reads ("/c-hub/revenue" is
// saved as c-hub__revenue.html).
export function refHtml(range: string, route: string): string {
    const file = path.join(captureFor(range, route).dir, range, `${route.slice(1).replace(/\//g, '__')}.html`);
    return fs.readFileSync(file, 'utf-8');
}

// The EUR/USD rate of the capture that refPage() reads for this page.
export function captureRateFor(range: string, route: string): number | undefined {
    return captureFor(range, route).rate;
}

// "€710,662.61" -> 710662.61, "+90.0% of selected revenue" -> 90, "n/a" -> null
export function displayed(value: string): number | null {
    const match = value.replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
}

// Round like Python's "{:.2f}": from the exact binary value (toFixed), so
// 3215.995 (stored as 3215.99499...) gives 3215.99.
export function round(value: number | null, decimals: number): number | null {
    return value === null ? null : Number(value.toFixed(decimals));
}

export function settled<T extends {date: string}>(days: T[]): T[] {
    return days.filter(d => d.date < SETTLED_BEFORE);
}

export {pyCompact, pyFixed, pyMoney} from '../lib/py-format.js';

