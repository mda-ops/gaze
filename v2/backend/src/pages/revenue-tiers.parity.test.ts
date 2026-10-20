import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {emptyFilters} from '../lib/filters.js';
import {pyFixed} from '../lib/py-format.js';
import {canCompare, captureRateFor, RANGES, refPage} from '../test-support/reference.js';
import {revenueTiers} from './revenue-tiers.js';

// /revenue-tiers against the Python app's captured cards and tables.

type Cell = string | number | null;

// Sums are added in a different order than pandas: numbers need only agree to
// 1e-9 relative. Mismatches are listed as [row, column, ours, theirs].
function expectSameTable(actual: Cell[][], expected: Cell[][]) {
    expect(actual.length).toBe(expected.length);
    const mismatches: unknown[] = [];
    actual.forEach((row, i) => row.forEach((value, j) => {
        const other = expected[i][j];
        const same = typeof value === 'number' && typeof other === 'number'
            ? Math.abs(value - other) <= 1e-9 * Math.max(1, Math.abs(other))
            : value === other;
        if (!same) mismatches.push([i, j, value, other]);
    }));
    expect(mismatches).toEqual([]);
}

const pick = <T extends object>(rows: T[], columns: string[]) => rows.map(r => columns.map(c => (r as Record<string, Cell>)[c]));

describe.skipIf(!canCompare)('Revenue Tiers parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const ref = refPage(name, '/revenue-tiers');
        const r = await revenueTiers(getFlowPool(), {
            start, end, compare: 'Previous period', filters: emptyFilters(), eurUsdRate: captureRateFor(name, '/revenue-tiers'),
        });
        const total = r.byModel.reduce((sum, m) => sum + m.selected_revenue, 0);
        const count = (t: string) => String(r.byModel.filter(m => m.weekly_tier === t).length);
        expect(ref.cards.map(c => c.value.replace(/^\W/, '')).slice(0, 5)).toEqual([
            pyFixed(total, 2), count('A'), count('B'), count('C'), r.byModel[0]?.model ?? 'n/a',
        ]);
        expect(ref.cards[0].note).toBe(`tips + messages only, ${r.days} days`);

        const [thresholds, summary, daily, weekly, monthly, byModel] = ref.tables;
        expect(pick(r.thresholds, ['cadence', 'tier', 'range'])).toEqual(thresholds.rows);
        expectSameTable(pick(r.tierSummary, ['cadence', 'tier', 'range', 'models', 'revenue', 'avg_model_revenue']), summary.rows);
        const assignment = ['cadence', 'tier', 'model', 'tier_revenue', 'selected_revenue', 'active_days', 'transactions'];
        expectSameTable(pick(r.assignments.daily, assignment), daily.rows);
        expectSameTable(pick(r.assignments.weekly, assignment), weekly.rows);
        expectSameTable(pick(r.assignments.monthly, assignment), monthly.rows);
        expectSameTable(pick(r.byModel, ['model', 'selected_revenue', 'active_days', 'transactions', 'daily_revenue', 'weekly_revenue',
            'monthly_revenue', 'daily_tier', 'weekly_tier', 'monthly_tier']), byModel.rows);
    }, 120_000);
});
