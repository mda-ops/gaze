import type pg from 'pg';
import {filterSql, type Filters} from '../lib/filters.js';
import {comparisonRange, daysBetweenInclusive, maxDate, minDate, addDays, type IsoDate} from '../lib/period.js';
import type {Settings} from '../lib/settings.js';
import {loadAccountTargets, loadScheduledHours, loadTeamBonusRules, type TeamBonusRule} from '../queries/finance-inputs.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import {FILTER_OPTIONS_SQL, filterOptions, PAGE_ROWS_CTE, type FilterOptions, type RawFilterOptions} from '../queries/page-rows.js';

// Commissions (/commissions and /c-hub/commissions). Reproduces the Python
// app's commissions handler for the Flow database: chatter commission (Flow's
// dated rates; no rate pays 0%, as in Flow), Flow's daily team bonuses,
// English chatter salary, chat-manager cuts, operating expenses and the
// gross/net and P&L tables. SQL compresses the period's transactions into small
// groups; the rules are applied here exactly as in the Python code.

export interface CommissionsInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    filters: Filters;
    settings: Settings;
    eurUsdRate?: number;
    // Parity tests only: reproduce the Python app, which paid rows without a
    // Flow rate from Gaze's own plan and never applied Flow's day-level bonus.
    legacy?: {missingRatePct: number; missingRatePlan: string};
}

type Amount = number | null;

// Python: financials.financial_ledger. Unknown inputs stay null.
export interface Ledger {
    source: string;
    gross_revenue: Amount;
    platform_share: Amount;
    creator_share: Amount;
    partner_share: Amount;
    other_share: Amount;
    external_revenue_splits: Amount;
    agency_revenue: Amount;
    chatter_commission: Amount;
    chatter_bonus: Amount;
    chatter_salary: Amount;
    manager_commission: Amount;
    other_direct_costs: Amount;
    direct_revenue_costs: Amount;
    net_revenue: Amount;
    operating_expenses: Amount;
    profit_loss: Amount;
    profit_margin_pct: Amount;
    net_revenue_margin_pct: Amount;
    is_complete: boolean;
}

function sumKnown(...values: Amount[]): Amount {
    return values.every(v => v !== null) ? values.reduce((s: number, v) => s + (v as number), 0) : null;
}

export function financialLedger(input: {
    gross: Amount; platform?: Amount; creator?: Amount; partner?: Amount; other?: Amount;
    chatterCommission?: Amount; chatterBonus?: Amount; chatterSalary?: Amount; managerCommission?: Amount;
    otherDirect?: Amount; operatingExpenses?: Amount; source: string;
}): Ledger {
    const v = (x: Amount | undefined) => (x === undefined ? null : x);
    const gross = v(input.gross);
    const external = sumKnown(v(input.platform), v(input.creator), v(input.partner), v(input.other));
    const agency = gross !== null && external !== null ? gross - external : null;
    const direct = sumKnown(v(input.chatterCommission), v(input.chatterBonus), v(input.chatterSalary), v(input.managerCommission), v(input.otherDirect));
    const net = agency !== null && direct !== null ? agency - direct : null;
    const opex = v(input.operatingExpenses);
    const pnl = net !== null && opex !== null ? net - opex : null;
    return {
        source: input.source,
        gross_revenue: gross,
        platform_share: v(input.platform),
        creator_share: v(input.creator),
        partner_share: v(input.partner),
        other_share: v(input.other),
        external_revenue_splits: external,
        agency_revenue: agency,
        chatter_commission: v(input.chatterCommission),
        chatter_bonus: v(input.chatterBonus),
        chatter_salary: v(input.chatterSalary),
        manager_commission: v(input.managerCommission),
        other_direct_costs: v(input.otherDirect),
        direct_revenue_costs: direct,
        net_revenue: net,
        operating_expenses: opex,
        profit_loss: pnl,
        profit_margin_pct: pnl !== null && gross ? pnl / gross * 100 : null,
        net_revenue_margin_pct: net !== null && gross ? net / gross * 100 : null,
        is_complete: [gross, external, direct, opex].every(x => x !== null),
    };
}

// Python: cost_team_name.
export function costTeam(team: string | null): '' | 'Dutch' | 'English' {
    const key = (team ?? '').trim().toLowerCase();
    if (key === 'nl' || key.includes('dutch')) return 'Dutch';
    if (key === 'en' || key.includes('english')) return 'English';
    return '';
}

// Python's "{pct:g}": up to 6 significant digits, no trailing zeros.
function pctLabel(pct: number): string {
    return String(Number(pct.toPrecision(6)));
}

// Python: operating_expense_breakdown's accrual: each calendar month's share
// by its real day count.
export function accrued(monthly: number, start: IsoDate, end: IsoDate): number {
    let total = 0;
    let cursor = start;
    while (cursor <= end) {
        const year = Number(cursor.slice(0, 4));
        const month = Number(cursor.slice(5, 7));
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const monthEnd = `${cursor.slice(0, 8)}${String(daysInMonth).padStart(2, '0')}`;
        const includedEnd = end < monthEnd ? end : monthEnd;
        total += monthly * (daysBetweenInclusive(cursor, includedEnd) / daysInMonth);
        cursor = addDays(includedEnd, 1);
    }
    return total;
}

interface FinanceQueryResult {
    currentRows: number;
    previousRows: number;
    revenue: number;
    previousRevenue: number;
    options: RawFilterOptions;
    finance: {
        rows: number;
        gross: number;
        netCount: number;
        net: number;
        commission: {date: string; platform: string | null; creator: string | null; chatter: string | null; team: string | null; pct: number | null; pool: string | null; revenue: number}[] | null;
        bonus: {date: string; team: string; chatter: string; creator_id: string; platform: string; revenue: number; net: number}[] | null;
        audit: {payable: [number, number]; noTeam: [number, number]; noRate: [number, number]; unattributed: [number, number]};
        managers: {team: string; manager: string; cut: number; revenue: number}[] | null;
        creators: {creator: string | null; gross: number; net: number}[] | null;
        costTeams: {team: string; gross: number}[] | null;
        shifts: {team: string; chatter: string; hours: number}[] | null;
    };
}

const MISSING_CHATTER = `(btrim(COALESCE(chatter, '')) = '' OR lower(btrim(chatter)) IN ('unknown', 'none', 'nan', 'unassigned'))`;
const COST_TEAM_SQL = `CASE
    WHEN lower(btrim(COALESCE(team, ''))) = 'nl' OR lower(COALESCE(team, '')) LIKE '%dutch%' THEN 'Dutch'
    WHEN lower(btrim(COALESCE(team, ''))) = 'en' OR lower(COALESCE(team, '')) LIKE '%english%' THEN 'English'
    ELSE '' END`;

// $1/$2 load range, $3 rate, $4/$5 period, $6/$7 comparison, then filters.
function querySql(filters: Filters, params: unknown[]): string {
    const all = filterSql(filters, params);
    return `
WITH ${PAGE_ROWS_CTE},
finance_rows AS (
    SELECT tx.date, tx.platform, tx.creator, tx.creator_id, tx.chatter, tx.team, tx.transaction_type,
           tx.flow_chatter_commission_pct AS pct, tx.flow_manager_commission_pct AS manager_pct,
           tx.flow_manager_name AS manager, tx.flow_commission_pool AS pool,
           CASE tx.currency WHEN 'USD' THEN tx.revenue / $3 ELSE tx.revenue END AS revenue,
           CASE tx.currency WHEN 'USD' THEN tx.net_amount / $3 ELSE tx.net_amount END AS net_amount
    FROM tx
    WHERE tx.date BETWEEN $4 AND $5 AND ${all}
      AND tx.revenue IS NOT NULL AND tx.revenue <> 0
      AND lower(btrim(COALESCE(tx.transaction_type, ''))) NOT IN ('summary', 'shift_summary', 'inactivity', '')
),
shift_rows AS (
    SELECT * FROM page_rows WHERE date BETWEEN $4 AND $5 AND transaction_type = 'shift_summary' AND ${all}
)
SELECT json_build_object(
    'currentRows', (SELECT count(*) FROM page_rows WHERE date BETWEEN $4 AND $5 AND ${all}),
    'previousRows', (SELECT count(*) FROM page_rows WHERE date BETWEEN $6 AND $7 AND ${all}),
    'revenue', (SELECT COALESCE(sum(revenue), 0) FROM page_rows WHERE date BETWEEN $4 AND $5 AND ${all}),
    'previousRevenue', (SELECT COALESCE(sum(revenue), 0) FROM page_rows WHERE date BETWEEN $6 AND $7 AND ${all}),
    'options', ${FILTER_OPTIONS_SQL},
    'finance', json_build_object(
        'rows', (SELECT count(*) FROM finance_rows),
        'gross', (SELECT COALESCE(sum(revenue), 0) FROM finance_rows),
        'netCount', (SELECT count(net_amount) FROM finance_rows),
        'net', (SELECT COALESCE(sum(net_amount), 0) FROM finance_rows),
        'commission', (SELECT json_agg(g) FROM (
            SELECT date, platform, creator, chatter, team, pct, pool, sum(revenue) AS revenue
            FROM finance_rows GROUP BY 1, 2, 3, 4, 5, 6, 7
        ) g),
        'bonus', (SELECT json_agg(b) FROM (
            SELECT date, team, chatter, COALESCE(creator_id, '') AS creator_id, upper(COALESCE(platform, '')) AS platform,
                   sum(revenue) AS revenue, sum(COALESCE(net_amount, revenue)) AS net
            FROM finance_rows
            WHERE btrim(COALESCE(team, '')) <> '' AND NOT ${MISSING_CHATTER}
            GROUP BY 1, 2, 3, 4, 5
        ) b),
        'audit', json_build_object(
            'payable', (SELECT json_build_array(count(*), COALESCE(sum(revenue), 0)) FROM finance_rows WHERE NOT ${MISSING_CHATTER} AND btrim(COALESCE(team, '')) <> '' AND pct IS NOT NULL),
            'noTeam', (SELECT json_build_array(count(*), COALESCE(sum(revenue), 0)) FROM finance_rows WHERE NOT ${MISSING_CHATTER} AND btrim(COALESCE(team, '')) = ''),
            'noRate', (SELECT json_build_array(count(*), COALESCE(sum(revenue), 0)) FROM finance_rows WHERE NOT ${MISSING_CHATTER} AND pct IS NULL),
            'unattributed', (SELECT json_build_array(count(*), COALESCE(sum(revenue), 0)) FROM finance_rows WHERE ${MISSING_CHATTER})
        ),
        'managers', (SELECT json_agg(m) FROM (
            SELECT btrim(team) AS team, COALESCE(NULLIF(btrim(COALESCE(manager, '')), ''), 'Unassigned manager') AS manager,
                   sum(revenue * manager_pct / 100) AS cut, sum(revenue) AS revenue
            FROM finance_rows WHERE manager_pct IS NOT NULL AND btrim(COALESCE(team, '')) <> ''
            GROUP BY 1, 2
        ) m),
        'creators', (SELECT json_agg(c) FROM (
            SELECT creator, sum(revenue) AS gross, sum(COALESCE(net_amount, 0)) AS net FROM finance_rows GROUP BY creator
        ) c),
        'costTeams', (SELECT json_agg(t) FROM (
            SELECT ${COST_TEAM_SQL} AS team, sum(revenue) AS gross
            FROM finance_rows GROUP BY 1
        ) t),
        'shifts', (SELECT json_agg(s) FROM (
            SELECT COALESCE(NULLIF(btrim(COALESCE(team, '')), ''), 'Unassigned') AS team,
                   COALESCE(NULLIF(btrim(COALESCE(chatter, '')), ''), 'Unassigned') AS chatter,
                   COALESCE(sum(shift_hours), 0) AS hours
            FROM shift_rows GROUP BY 1, 2
        ) s)
    )
) AS result`;
}

export interface ChatterCommission {
    team: string;
    chatter: string;
    baseCommission: number;
    commissionPlan: string;
    salaryCost: number;
    flowBonus: number;
    preSalaryCommission: number;
    postSalaryCommission: number;
}

export interface Commissions {
    period: {start: IsoDate; end: IsoDate; compare: string; compareStart: IsoDate; compareEnd: IsoDate};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    ledger: Ledger;
    cards: {
        baseCommission: number;
        flowBonus: number;
        preSalaryCommission: number;
        salaryCost: number;
        postSalaryCommission: number;
        chatManagerCuts: number;
        adminManagementPool: number;
        operatingExpenses: number;
        operatingExpensesEur: number;
        operatingExpensesUsd: number;
        mdEarningsAfterExpenses: number;
    };
    breakdown: {lineItem: string; amount: Amount; sharePct: Amount; source: string}[];
    pnl: {line: string; amount: Amount}[];
    teams: {team: string; baseCommission: number; flowBonus: number; preSalaryCommission: number; salaryCost: number; postSalaryCommission: number}[];
    audit: {status: string; transactions: number; revenue: number; meaning: string}[];
    managers: {team: string; chatManager: string; managerCut: number; attributedRevenue: number; managerCutPct: number}[];
    departments: {department: string; monthlyEur: number; monthlyUsd: number; periodEur: number; periodUsd: number; periodEurReporting: number}[];
    costTeams: {team: string; grossRevenue: Amount; nonChatterCosts: Amount; preSalary: number; salaryCost: number; totalCost: Amount; postSalary: number}[];
    chatters: ChatterCommission[];
    creators: {creator: string | null; grossRev: number; netRev: number}[];
    filterOptions: FilterOptions;
}

// Python: flow_bonus_by_chatter.
export function flowBonuses(rows: NonNullable<FinanceQueryResult['finance']['bonus']>, rules: TeamBonusRule[], targets: {creatorId: string; platform: string; target: number}[], rate: number, legacy: boolean): Map<string, number> {
    const ruleByTeam = new Map(rules.map(r => [r.team.toLowerCase(), r]));
    const targetByAccount = new Map<string, number>();
    for (const t of targets) {
        if (!(t.target > 0)) continue;
        const platform = t.platform.toUpperCase();
        targetByAccount.set(`${t.creatorId}|${platform}`, ['OF', 'KNKY'].includes(platform) ? t.target / rate : t.target);
    }
    const accountDaily = new Map<string, number>();
    for (const r of rows) {
        const key = `${r.date}|${r.creator_id}|${r.platform}`;
        accountDaily.set(key, (accountDaily.get(key) ?? 0) + Number(r.revenue));
    }
    const bonuses = new Map<string, number>();
    const add = (team: string, chatter: string, amount: number) => {
        const key = `${team}\u0000${chatter}`;
        bonuses.set(key, (bonuses.get(key) ?? 0) + amount);
    };
    // Tiered per account and day: the chatter's own revenue on that account x
    // the highest tier whose threshold (multiple of the account target) the
    // account's day reached.
    const tiered = new Map<string, {team: string; chatter: string; creatorId: string; platform: string; date: string; revenue: number; rule: TeamBonusRule}>();
    const flat = new Map<string, {team: string; chatter: string; net: number; rule: TeamBonusRule}>();
    for (const r of rows) {
        const rule = ruleByTeam.get(r.team.toLowerCase());
        if (!rule) continue;
        if (rule.type === 'per_account_tiered') {
            const key = [r.date, r.team, r.chatter, r.creator_id, r.platform].join('\u0000');
            const entry = tiered.get(key) ?? {team: r.team, chatter: r.chatter, creatorId: r.creator_id, platform: r.platform, date: r.date, revenue: 0, rule};
            entry.revenue += Number(r.revenue);
            tiered.set(key, entry);
        } else if (rule.type === 'flat_day_threshold') {
            const key = [r.date, r.team, r.chatter].join('\u0000');
            const entry = flat.get(key) ?? {team: r.team, chatter: r.chatter, net: 0, rule};
            entry.net += Number(r.net);
            flat.set(key, entry);
        }
    }
    for (const e of tiered.values()) {
        const target = targetByAccount.get(`${e.creatorId}|${e.platform}`);
        if (!target) continue;
        const accountRevenue = accountDaily.get(`${e.date}|${e.creatorId}|${e.platform}`) ?? 0;
        const matched = (e.rule.config?.tiers ?? []).filter(t => accountRevenue >= target * Number(t.thresholdMultiplier ?? 0));
        if (!matched.length) continue;
        // Python max(): the first tier with the highest multiplier.
        const best = matched.reduce((a, b) => (Number(b.thresholdMultiplier ?? 0) > Number(a.thresholdMultiplier ?? 0) ? b : a));
        add(e.team, e.chatter, e.revenue * Number(best.rate ?? 0));
    }
    // Flat per chatter and day, as in Flow: the tier with the highest
    // thresholdUsd the day's net amount clears pays its rate on the whole day.
    // The Python app read thresholdUsd/rate from the top level of the config,
    // where Flow no longer keeps them, so it never paid this bonus.
    for (const e of flat.values()) {
        if (legacy) continue;
        const cleared = (e.rule.config?.tiers ?? []).filter(t => e.net >= Number(t.thresholdUsd ?? 0) / rate);
        if (!cleared.length) continue;
        const best = cleared.reduce((a, b) => (Number(b.thresholdUsd ?? 0) > Number(a.thresholdUsd ?? 0) ? b : a));
        add(e.team, e.chatter, e.net * Number(best.rate ?? 0));
    }
    return bonuses;
}

export async function commissions(pool: pg.Pool, input: CommissionsInput): Promise<Commissions> {
    const {start, end, compare, filters, settings} = input;
    const [compareStart, compareEnd] = comparisonRange(start, end, compare);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const params: unknown[] = [minDate(start, compareStart), maxDate(end, compareEnd), rate, start, end, compareStart, compareEnd];
    const [queryResult, rules, targets, scheduled] = await Promise.all([
        pool.query<{result: FinanceQueryResult}>(querySql(filters, params), params),
        loadTeamBonusRules(pool),
        loadAccountTargets(pool),
        loadScheduledHours(pool, start, end),
    ]);
    const q = queryResult.rows[0].result;
    const f = q.finance;
    const legacy = input.legacy;

    // --- Finance breakdown (Python: finance_breakdown). Flow rows carry
    // net_amount but no classified splits, so the net amount is a reference
    // only and the external splits stay unknown (also without a net amount:
    // Gaze has no commission plans of its own).
    const usesNetAmount = f.netCount > 0;
    let finance: Ledger;
    let reportedFlowNet: Amount = null;
    if (!f.rows) {
        finance = financialLedger({gross: null, source: 'No transaction rows'});
    } else {
        finance = financialLedger({gross: f.gross, source: usesNetAmount ? 'RevenueCatcher net amount' : 'Gross revenue only'});
        if (usesNetAmount) reportedFlowNet = f.net;
    }

    // --- Chatter commission (Python: commission_cost_breakdown).
    const perChatter = new Map<string, {team: string; chatter: string; base: number; plans: Set<string>}>();
    for (const g of f.commission ?? []) {
        const team = (g.team ?? '').trim() || 'Unassigned';
        const chatter = (g.chatter ?? '').trim() || 'Unassigned';
        // Revenue without an attributed chatter is not a payable commission.
        if (chatter === 'Unassigned') continue;
        const revenue = Number(g.revenue);
        // Like Flow, a chatter without a rate for the date earns 0%.
        const pct = g.pct !== null ? Number(g.pct) : legacy?.missingRatePct ?? 0;
        const base = revenue * pct / 100;
        const pool = (g.pool ?? '').trim();
        const plan = g.pct !== null
            ? `Flow rate ${pctLabel(Number(g.pct))}%${pool ? ` · ${pool}` : ''}`
            : legacy?.missingRatePlan ?? 'No Flow rate (0%)';
        const key = `${team}\u0000${chatter}`;
        const entry = perChatter.get(key) ?? {team, chatter, base: 0, plans: new Set<string>()};
        entry.base += base;
        if (plan) entry.plans.add(plan);
        perChatter.set(key, entry);
    }

    // English chatter salary: worked hours x the USD rate (Dutch chatters are
    // commission-only). Scheduled hours only when no English shift exists.
    const englishHourlyEur = Number(settings.english_chatter_salary_usd_per_hour ?? 2) / rate;
    let salaries = (f.shifts ?? []).map(s => ({team: s.team, chatter: s.chatter, salary: costTeam(s.team) === 'English' ? Number(s.hours) * englishHourlyEur : 0}));
    if (!salaries.some(s => costTeam(s.team) === 'English')) {
        const english = scheduled.filter(s => costTeam(s.team) === 'English' && s.chatter);
        if (english.length) salaries = english.map(s => ({team: s.team, chatter: s.chatter, salary: s.hours * englishHourlyEur}));
    }
    const salaryByChatter = new Map<string, number>();
    for (const s of salaries) salaryByChatter.set(`${s.team}\u0000${s.chatter}`, (salaryByChatter.get(`${s.team}\u0000${s.chatter}`) ?? 0) + s.salary);

    const bonuses = flowBonuses(f.bonus ?? [], rules, targets, rate, legacy !== undefined);
    const chatters: ChatterCommission[] = [...perChatter.entries()].map(([key, e]) => {
        const flowBonus = bonuses.get(key) ?? 0;
        const salaryCost = salaryByChatter.get(key) ?? 0;
        const pre = e.base + flowBonus;
        return {
            team: e.team, chatter: e.chatter, baseCommission: e.base,
            commissionPlan: [...e.plans].sort().join(', '),
            salaryCost, flowBonus, preSalaryCommission: pre, postSalaryCommission: pre - salaryCost,
        };
    }).sort((a, b) => b.preSalaryCommission - a.preSalaryCommission);

    const teamMap = new Map<string, Commissions['teams'][number]>();
    for (const c of chatters) {
        const t = teamMap.get(c.team) ?? {team: c.team, baseCommission: 0, flowBonus: 0, preSalaryCommission: 0, salaryCost: 0, postSalaryCommission: 0};
        t.baseCommission += c.baseCommission;
        t.flowBonus += c.flowBonus;
        t.preSalaryCommission += c.preSalaryCommission;
        t.salaryCost += c.salaryCost;
        t.postSalaryCommission += c.postSalaryCommission;
        teamMap.set(c.team, t);
    }
    const teams = [...teamMap.values()].sort((a, b) => b.preSalaryCommission - a.preSalaryCommission);
    const total = (key: keyof ChatterCommission) => chatters.reduce((s, c) => s + (c[key] as number), 0);
    const baseTotal = total('baseCommission');
    const bonusTotal = total('flowBonus');
    const salaryTotal = total('salaryCost');

    // --- Chat-manager cuts and the remaining admin/management pool.
    const managers = (f.managers ?? [])
        .map(m => ({team: m.team, chatManager: m.manager, managerCut: Number(m.cut), attributedRevenue: Number(m.revenue),
            managerCutPct: Number(m.revenue) ? Number(m.cut) / Number(m.revenue) * 100 : 0}))
        .sort((a, b) => b.managerCut - a.managerCut);
    const managerCuts = managers.reduce((s, m) => s + m.managerCut, 0);
    const reportedPool = finance.net_revenue ?? reportedFlowNet;
    const adminPool = Number(reportedPool ?? 0) - managerCuts;

    // --- Operating expenses accrued over the period.
    const expenses = (Array.isArray(settings.operating_expenses) ? settings.operating_expenses : []) as {department?: string; currency?: string; monthly_amount?: number}[];
    const departmentMap = new Map<string, Commissions['departments'][number]>();
    for (const e of expenses) {
        const department = e.department ?? 'Unassigned';
        const currency = String(e.currency ?? 'EUR').trim().toUpperCase();
        const monthly = Number(e.monthly_amount ?? 0) || 0;
        const period = start <= end ? accrued(monthly, start, end) : 0;
        const d = departmentMap.get(department) ?? {department, monthlyEur: 0, monthlyUsd: 0, periodEur: 0, periodUsd: 0, periodEurReporting: 0};
        if (currency === 'EUR') { d.monthlyEur += monthly; d.periodEur += period; }
        if (currency === 'USD') { d.monthlyUsd += monthly; d.periodUsd += period; }
        d.periodEurReporting += (currency === 'EUR' ? period : 0) + (currency === 'USD' ? period : 0) / rate;
        departmentMap.set(department, d);
    }
    const departments = [...departmentMap.values()].sort((a, b) => b.periodEurReporting - a.periodEurReporting);
    const opexTotal = departments.reduce((s, d) => s + d.periodEurReporting, 0);

    // --- Final ledger with the calculated direct costs.
    const ledger = financialLedger({
        gross: finance.gross_revenue, platform: finance.platform_share, creator: finance.creator_share,
        partner: finance.partner_share, other: finance.other_share, chatterCommission: baseTotal, chatterBonus: bonusTotal,
        chatterSalary: salaryTotal, managerCommission: managerCuts, otherDirect: 0, operatingExpenses: opexTotal, source: finance.source,
    });
    const gross = Number(ledger.gross_revenue ?? 0);
    const share = (value: Amount) => (gross ? Number(value ?? 0) / gross * 100 : null);
    const line = (lineItem: string, amount: Amount, source: string) => ({lineItem, amount, sharePct: share(amount), source});
    const breakdown = [
        line('Gross Revenue', ledger.gross_revenue, ledger.source),
        line('Platform share / fees', ledger.platform_share, 'platform fee rate'),
        line('Creator share', ledger.creator_share, 'model profile split'),
        line('Partner share', ledger.partner_share, 'model profile split'),
        line('Other share', ledger.other_share, 'model profile split'),
        line('Agency Revenue', ledger.agency_revenue, 'gross less external revenue splits'),
        line('Chatter commission', ledger.chatter_commission, 'chatter commission structure'),
        line('Chat manager commission', ledger.manager_commission, 'manager commission routing'),
        line('Direct Revenue Costs', ledger.direct_revenue_costs, 'tracked direct costs'),
        line('Net Revenue', ledger.net_revenue, 'agency revenue less direct costs'),
    ];
    const negate = (v: Amount) => (v === null ? null : -v);
    const pnl = [
        {line: 'Gross Revenue', amount: ledger.gross_revenue},
        {line: 'Less External Revenue Splits', amount: negate(ledger.external_revenue_splits)},
        {line: 'Agency Revenue', amount: ledger.agency_revenue},
        {line: 'Less Direct Revenue Costs', amount: negate(ledger.direct_revenue_costs)},
        {line: 'Net Revenue', amount: ledger.net_revenue},
        {line: 'Less Operating Expenses', amount: negate(ledger.operating_expenses)},
        {line: 'P&L Profit/Loss', amount: ledger.profit_loss},
    ];

    // --- Dutch / English team costs (Python: dutch_english_cost_breakdown).
    // Flow rows carry no classified payouts, so non-chatter costs stay unknown.
    const costTeams = (['Dutch', 'English'] as const).map(team => {
        const finance = (f.costTeams ?? []).find(t => t.team === team);
        const own = teams.filter(t => costTeam(t.team) === team);
        const pre = own.reduce((s, t) => s + t.preSalaryCommission, 0);
        const salary = own.reduce((s, t) => s + t.salaryCost, 0);
        return {
            team, grossRevenue: finance ? Number(finance.gross) : null, nonChatterCosts: null, preSalary: pre, salaryCost: salary,
            totalCost: null,
            postSalary: own.reduce((s, t) => s + t.postSalaryCommission, 0),
        };
    });

    const audit = [
        {status: 'Payable: chatter, team, and Flow rate', counts: f.audit.payable, meaning: 'Used in the Dutch or English Flow payout calculation.'},
        {status: 'Payable: team assignment missing', counts: f.audit.noTeam, meaning: 'A chatter is known, but Flow has no effective team assignment for this date.'},
        {status: 'Payable: Flow rate missing', counts: f.audit.noRate, meaning: legacy ? 'A chatter is known; Gaze used its legacy plan until a Flow rate is recorded.' : 'A chatter is known, but Flow has no rate for this date, so Flow pays 0% until one is recorded.'},
        {status: 'Not payable: chatter attribution missing', counts: f.audit.unattributed, meaning: 'Revenue is retained in finance totals but excluded from chatter commission until Flow assigns a chatter.'},
    ].map(a => ({status: a.status, transactions: Number(a.counts[0]), revenue: Number(a.counts[1]), meaning: a.meaning}));

    const creators = (f.creators ?? [])
        .map(c => ({creator: c.creator, grossRev: Number(c.gross), netRev: Number(c.net)}))
        .sort((a, b) => b.grossRev - a.grossRev);

    return {
        period: {start, end, compare, compareStart, compareEnd},
        eurUsdRate: rate,
        comparison: {
            currentRevenue: q.currentRows ? q.revenue : null,
            previousRevenue: q.previousRows ? q.previousRevenue : null,
        },
        ledger,
        cards: {
            baseCommission: baseTotal,
            flowBonus: bonusTotal,
            preSalaryCommission: total('preSalaryCommission'),
            salaryCost: salaryTotal,
            postSalaryCommission: total('postSalaryCommission'),
            chatManagerCuts: managerCuts,
            adminManagementPool: adminPool,
            operatingExpenses: opexTotal,
            operatingExpensesEur: departments.reduce((s, d) => s + d.periodEur, 0),
            operatingExpensesUsd: departments.reduce((s, d) => s + d.periodUsd, 0),
            mdEarningsAfterExpenses: adminPool - opexTotal,
        },
        breakdown,
        pnl,
        teams,
        audit,
        managers,
        departments,
        costTeams,
        chatters,
        creators,
        filterOptions: filterOptions(q.options),
    };
}
