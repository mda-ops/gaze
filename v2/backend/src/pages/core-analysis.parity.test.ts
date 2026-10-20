import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {emptyFilters} from '../lib/filters.js';
import {canCompare, captureRateFor, RANGES, refPage} from '../test-support/reference.js';
import {coreAnalysis, type Group, type GroupRow} from './core-analysis.js';

// /revenue, /chatters, /creators and /platforms against the Python app's
// captured tables (raw cell values; missing values captured as '').

type Cell = string | number | null;

const GROUP_COLUMNS: (keyof GroupRow)[] = [
    'key', 'revenue', 'hours', 'messages', 'inactivity', 'transactions', 'creators_worked', 'days', 'previous_revenue', 'change_amount',
    'change_pct', 'revenue_per_hour', 'messages_per_hour', 'revenue_share_pct', 'average_revenue_per_day', 'average_transaction_value',
];
const EXTRA_COLUMNS = ['active_chatters', 'unlock_revenue', 'tip_revenue', 'subscription_revenue', 'revenue_per_chatter'] as const;

function norm(value: Cell): Cell {
    return value === '' ? null : value;
}

// Equal revenues are in arbitrary order in the Python app (unstable sort):
// compare in a fixed order within them.
function canonical(rows: Cell[][], nameAt: number, revenueAt: number): Cell[][] {
    return rows.map(r => r.map(norm)).sort((a, b) =>
        Number(b[revenueAt]) - Number(a[revenueAt]) || String(a[nameAt]).localeCompare(String(b[nameAt])));
}

// Float sums are added in a different order than pandas: numbers need only
// agree to 1e-9 relative. Mismatches are listed as [row, column, ours, theirs].
function expectSameTable(actual: Cell[][], expected: Cell[][]) {
    expect(actual.length).toBe(expected.length);
    const mismatches: unknown[] = [];
    actual.forEach((row, i) => row.forEach((value, j) => {
        const other = expected[i][j];
        const same = typeof value === 'number' && typeof other === 'number'
            ? Math.abs(value - other) <= 1e-9 * Math.max(1, Math.abs(other))
            : value === other;
        if (!same) mismatches.push([expected[i][0], j, value, other]);
    }));
    expect(mismatches).toEqual([]);
}

const cells = <T extends object>(rows: T[], columns: readonly string[]) =>
    rows.map(row => columns.map(c => (row as Record<string, Cell>)[c] ?? null));

async function analysis(range: string, start: string, end: string, route: string, groups: Group[]) {
    return coreAnalysis(getFlowPool(), {
        start, end, compare: 'Previous period', filters: emptyFilters(), groups, eurUsdRate: captureRateFor(range, route),
    });
}

describe.skipIf(!canCompare)('Core analysis parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('/revenue %s', async (name, start, end) => {
        const ref = refPage(name, '/revenue');
        const result = await analysis(name, start, end, '/revenue', ['creator', 'chatter']);
        expectSameTable(cells(result.revenueByType, ['transaction_type', 'revenue', 'days', 'rows']), ref.tables![0].rows.map(r => r.map(norm)));
        expectSameTable(canonical(cells(result.groups.creator!, GROUP_COLUMNS), 0, 1), canonical(ref.tables![1].rows, 0, 1));
        expectSameTable(canonical(cells(result.groups.chatter!, GROUP_COLUMNS), 0, 1), canonical(ref.tables![2].rows, 0, 1));
    }, 120_000);

    it.each(RANGES)('/chatters %s', async (name, start, end) => {
        const ref = refPage(name, '/chatters');
        const result = await analysis(name, start, end, '/chatters', ['chatter']);
        const rows = cells(result.groups.chatter!, GROUP_COLUMNS);
        // The rank column follows the (tie-dependent) row order, so check it separately.
        expect(ref.tables![0].rows.map(r => r[0])).toEqual(rows.map((_, i) => i + 1));
        expectSameTable(canonical(rows, 0, 1), canonical(ref.tables![0].rows.map(r => r.slice(1)), 0, 1));
    }, 120_000);

    it.each(RANGES)('/creators %s', async (name, start, end) => {
        const ref = refPage(name, '/creators');
        const result = await analysis(name, start, end, '/creators', ['creator']);
        expectSameTable(canonical(cells(result.creatorExtras!, [...GROUP_COLUMNS, ...EXTRA_COLUMNS]), 0, 1), canonical(ref.tables![0].rows, 0, 1));
    }, 120_000);

    it.each(RANGES)('/platforms %s', async (name, start, end) => {
        const ref = refPage(name, '/platforms');
        const result = await analysis(name, start, end, '/platforms', ['platform']);
        expectSameTable(canonical(cells(result.groups.platform!, GROUP_COLUMNS), 0, 1), canonical(ref.tables![0].rows, 0, 1));
        expectSameTable(cells(result.revenueByType, ['transaction_type', 'revenue', 'days', 'rows']), ref.tables![1].rows.map(r => r.map(norm)));
    }, 120_000);
});
