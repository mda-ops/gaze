import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {emptyFilters} from '../lib/filters.js';
import {loadSettings} from '../lib/settings.js';
import {canCompare, captureRateFor, displayed, RANGES, refPage, round} from '../test-support/reference.js';
import {commissions} from './commissions.js';

// Commissions against the Python app's captured page (default settings: the
// demo commission plan and the default operating expenses). The "legacy"
// option reproduces the two places where v2 now follows Flow instead: rows
// without a Flow rate got the demo plan's 8%, and Flow's day-level bonus never
// applied (docs/rewrite/01-intended-differences.md).

// A table cell as captured: '' for a missing value, numbers unrounded.
function cell(value: string | number | null): unknown {
    if (value === '' || value === null) return null;
    return typeof value === 'number' ? expect.closeTo(value, 6) : value;
}

function mine(value: number | string | null): unknown {
    return value === '' ? null : value;
}

// The 2026-10-01 page comes from the 2026-10-16 re-capture (see test-support/reference.ts).

describe.skipIf(!canCompare)('Commissions parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const ref = refPage(name, '/c-hub/commissions');
        const card = (label: string) => ref.cards.find(c => c.label === label)!;
        const settings = await loadSettings(null);
        const r = await commissions(getFlowPool(), {start, end, compare: 'Previous period', filters: emptyFilters(), settings, eurUsdRate: captureRateFor(name, '/c-hub/commissions'),
            legacy: {missingRatePct: 8, missingRatePlan: 'Default demo rule'}});
        const c = r.cards;

        expect({
            base: round(c.baseCommission, 2), bonus: round(c.flowBonus, 2), pre: round(c.preSalaryCommission, 2),
            salary: round(c.salaryCost, 2), post: round(c.postSalaryCommission, 2), managers: round(c.chatManagerCuts, 2),
            pool: round(c.adminManagementPool, 2), opex: round(c.operatingExpenses, 2), md: round(c.mdEarningsAfterExpenses, 2),
        }).toEqual({
            base: displayed(card('Chatter Base Commission').value), bonus: displayed(card('Flow Chatter Bonus').value),
            pre: displayed(card('Chatter Commission').value), salary: displayed(card('Chatter Salary').value),
            post: displayed(card('Commission After Salary').value), managers: displayed(card('Chat Manager Cuts').value),
            pool: displayed(card('Admin & Management Pool').value), opex: displayed(card('Operating Expenses').value),
            md: displayed(card('MD Earnings After Expenses').value),
        });

        // The captured Commission Plan table (Gaze's own plans) is gone in v2.
        const [breakdown, pnl, teams, audit, managers, departments, costTeams, chatters, , creators] = ref.tables;
        const same = (rows: (string | number | null)[][], refRows: (string | number | null)[][]) =>
            expect(rows.map(row => row.map(mine))).toEqual(refRows.map(row => row.map(cell)));

        same(r.breakdown.map(b => [b.lineItem, b.amount, b.sharePct, b.source]), breakdown.rows);
        same(r.pnl.map(p => [p.line, p.amount]), pnl.rows);
        same(r.teams.map(t => [t.team, t.baseCommission, t.flowBonus, t.preSalaryCommission, t.salaryCost, t.postSalaryCommission]), teams.rows);
        same(r.audit.map(a => [a.status, a.transactions, a.revenue, a.meaning]), audit.rows);
        same(r.managers.map(m => [m.team, m.chatManager, m.managerCut, m.attributedRevenue, m.managerCutPct]), managers.rows);
        same(r.departments.map(d => [d.department, d.monthlyEur, d.monthlyUsd, d.periodEur, d.periodUsd, d.periodEurReporting]), departments.rows);
        same(r.costTeams.map(t => [t.team, t.grossRevenue, t.nonChatterCosts, t.preSalary, t.salaryCost, t.totalCost, t.postSalary]), costTeams.rows);
        same(r.chatters.map(x => [x.team, x.chatter, x.baseCommission, x.commissionPlan, x.salaryCost, x.flowBonus, x.preSalaryCommission, x.postSalaryCommission]), chatters.rows);
        same(r.creators.map(x => [x.creator, x.grossRev, x.netRev, 0, 0, 0, 0, 0, 0]), creators.rows);
    }, 180_000);
});
