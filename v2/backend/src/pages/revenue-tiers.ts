import type pg from 'pg';
import {filterSql, type Filters} from '../lib/filters.js';
import {comparisonRange, daysBetweenInclusive, maxDate, minDate, type IsoDate} from '../lib/period.js';
import {pyFixed} from '../lib/py-format.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import {FILTER_OPTIONS_SQL, filterOptions, PAGE_ROWS_CTE, type FilterOptions, type RawFilterOptions} from '../queries/page-rows.js';

// /revenue-tiers (Python app: revenue_tiers + revenue_tiers.py
// build_revenue_tiers). Each model's tips + messages revenue in the period is
// turned into a daily, weekly and monthly pace and given tier A, B or C.

export interface RevenueTiersInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    filters: Filters;
    eurUsdRate?: number;
}

const CADENCES = ['daily', 'weekly', 'monthly'] as const;
type Cadence = typeof CADENCES[number];
const LABELS: Record<Cadence, string> = {daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly'};
const THRESHOLDS: Record<Cadence, {A: number; B: number}> = {
    daily: {A: 1430, B: 715},
    weekly: {A: 10000, B: 5000},
    monthly: {A: 40000, B: 20000},
};
const TIERS = ['A', 'B', 'C'] as const;
type Tier = typeof TIERS[number];

export interface ModelTier {
    model: string;
    selected_revenue: number;
    active_days: number;
    transactions: number;
    daily_revenue: number;
    weekly_revenue: number;
    monthly_revenue: number;
    daily_tier: Tier;
    weekly_tier: Tier;
    monthly_tier: Tier;
}

export interface Assignment {
    cadence: string; tier: string; model: string; tier_revenue: number; selected_revenue: number; active_days: number; transactions: number;
}

export interface RevenueTiers {
    period: {start: IsoDate; end: IsoDate; compare: string; compareStart: IsoDate; compareEnd: IsoDate};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    days: number;
    byModel: ModelTier[];
    thresholds: {cadence: string; tier: string; range: string}[];
    tierSummary: {cadence: string; tier: string; range: string; models: number; revenue: number; avg_model_revenue: number}[];
    weeklyMix: {tier: string; models: number; revenue: number}[];
    topModels: {model: string; weekly_revenue: number; weekly_tier: string}[];
    assignments: Record<Cadence, Assignment[]>;
    filterOptions: FilterOptions;
}

function tierFor(amount: number, cadence: Cadence): Tier {
    const t = THRESHOLDS[cadence];
    return amount >= t.A ? 'A' : amount >= t.B ? 'B' : 'C';
}

function rangeLabel(cadence: Cadence, tier: Tier): string {
    const t = THRESHOLDS[cadence];
    if (tier === 'A') return `>= EUR ${pyFixed(t.A, 0)}`;
    if (tier === 'B') return `EUR ${pyFixed(t.B, 0)} - EUR ${pyFixed(t.A - 0.01, 0)}`;
    return `< EUR ${pyFixed(t.B, 0)}`;
}

const codePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The pure part of build_revenue_tiers, from each model's totals.
export function buildRevenueTiers(models: {model: string; revenue: number; days: number; rows: number}[], days: number) {
    const byModel: ModelTier[] = [...models]
        // groupby order (model name), then the stable sort below.
        .sort((a, b) => codePoint(a.model, b.model))
        .map(m => {
            const daily = m.revenue / days;
            const weekly = daily * 7;
            const monthly = daily * 30;
            return {
                model: m.model, selected_revenue: m.revenue, active_days: m.days, transactions: m.rows,
                daily_revenue: daily, weekly_revenue: weekly, monthly_revenue: monthly,
                daily_tier: tierFor(daily, 'daily'), weekly_tier: tierFor(weekly, 'weekly'), monthly_tier: tierFor(monthly, 'monthly'),
            };
        })
        .sort((a, b) => codePoint(a.weekly_tier, b.weekly_tier) || b.weekly_revenue - a.weekly_revenue || b.selected_revenue - a.selected_revenue);

    const revenueOf = (m: ModelTier, cadence: Cadence) => m[`${cadence}_revenue`];
    const tierOf = (m: ModelTier, cadence: Cadence) => m[`${cadence}_tier`];

    const thresholds = CADENCES.flatMap(c => TIERS.map(t => ({cadence: LABELS[c], tier: `Tier ${t}`, range: rangeLabel(c, t)})));
    const tierSummary = byModel.length ? CADENCES.flatMap(c => TIERS.map(t => {
        const rows = byModel.filter(m => tierOf(m, c) === t);
        const revenue = rows.reduce((sum, m) => sum + revenueOf(m, c), 0);
        return {cadence: LABELS[c], tier: `Tier ${t}`, range: rangeLabel(c, t), models: rows.length, revenue, avg_model_revenue: rows.length ? revenue / rows.length : 0};
    })) : [];
    // groupby weekly_tier: only the tiers that occur, in tier order.
    const weeklyMix = TIERS.filter(t => byModel.some(m => m.weekly_tier === t)).map(t => {
        const rows = byModel.filter(m => m.weekly_tier === t);
        return {tier: `Tier ${t}`, models: rows.length, revenue: rows.reduce((sum, m) => sum + m.weekly_revenue, 0)};
    });
    // Python sorts by weekly pace with an unstable sort; equal paces keep the order above here.
    const topModels = [...byModel].sort((a, b) => b.weekly_revenue - a.weekly_revenue).slice(0, 12)
        .map(m => ({model: m.model, weekly_revenue: m.weekly_revenue, weekly_tier: `Tier ${m.weekly_tier}`}));
    const assignments = Object.fromEntries(CADENCES.map(c => [c, TIERS.flatMap(t =>
        byModel.filter(m => tierOf(m, c) === t)
            .sort((a, b) => revenueOf(b, c) - revenueOf(a, c))
            .map(m => ({
                cadence: LABELS[c], tier: `Tier ${t}`, model: m.model, tier_revenue: revenueOf(m, c),
                selected_revenue: m.selected_revenue, active_days: m.active_days, transactions: m.transactions,
            })))])) as Record<Cadence, Assignment[]>;
    return {byModel, thresholds, tierSummary, weeklyMix, topModels, assignments};
}

interface ResultRow {
    currentRows: number;
    previousRows: number;
    revenue: number;
    previousRevenue: number;
    hasDetailed: boolean;
    models: {model: string; revenue: number; days: number; rows: number}[];
    options: RawFilterOptions;
}

const DETAILED_TYPES = `('tip', 'tips', 'message', 'messages', 'subscription', 'subscriptions', 'ppv')`;
const NAMED_MODEL = `btrim(COALESCE(creator, '')) NOT IN ('', 'Unknown', 'None', 'nan')`;

export async function revenueTiers(pool: pg.Pool, input: RevenueTiersInput): Promise<RevenueTiers> {
    const {start, end, compare, filters} = input;
    const [compareStart, compareEnd] = comparisonRange(start, end, compare);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const params: unknown[] = [minDate(start, compareStart), maxDate(end, compareEnd), rate, start, end, compareStart, compareEnd];
    const where = filterSql(filters, params);
    // Python: model_revenue_source keeps the detailed revenue rows when any of
    // them has a named model and positive revenue; tiers then count tips and
    // messages only, positive rows only.
    const result = await pool.query<{result: ResultRow}>(`
WITH ${PAGE_ROWS_CTE},
current_rows AS MATERIALIZED (SELECT * FROM page_rows WHERE date BETWEEN $4 AND $5 AND ${where}),
previous_rows AS (SELECT * FROM page_rows WHERE date BETWEEN $6 AND $7 AND ${where})
SELECT json_build_object(
    'currentRows', (SELECT count(*) FROM current_rows),
    'previousRows', (SELECT count(*) FROM previous_rows),
    'revenue', (SELECT COALESCE(sum(revenue), 0) FROM current_rows),
    'previousRevenue', (SELECT COALESCE(sum(revenue), 0) FROM previous_rows),
    'hasDetailed', EXISTS (SELECT 1 FROM current_rows
        WHERE lower(btrim(COALESCE(transaction_type, ''))) IN ${DETAILED_TYPES} AND ${NAMED_MODEL} AND revenue > 0),
    'models', (SELECT COALESCE(json_agg(json_build_object('model', model, 'revenue', revenue, 'days', days, 'rows', rows)), '[]'::json) FROM (
        SELECT btrim(creator) AS model, sum(revenue) AS revenue, count(DISTINCT date) AS days, count(*) AS rows
        FROM current_rows
        WHERE lower(btrim(COALESCE(transaction_type, ''))) IN ('tip', 'tips', 'message', 'messages') AND ${NAMED_MODEL} AND revenue > 0
        GROUP BY 1
    ) m),
    'options', ${FILTER_OPTIONS_SQL}
) AS result`, params);
    const r = result.rows[0].result;
    const days = Math.max(1, daysBetweenInclusive(start, end));
    // Without detailed rows the Python app tries Revenue Catcher's HTTP API
    // (not carried over) and otherwise shows empty tiers.
    const tiers = buildRevenueTiers(r.hasDetailed ? r.models : [], days);
    return {
        period: {start, end, compare, compareStart, compareEnd},
        eurUsdRate: rate,
        comparison: {
            currentRevenue: r.currentRows ? r.revenue : null,
            previousRevenue: r.previousRows ? r.previousRevenue : null,
        },
        days,
        ...tiers,
        filterOptions: filterOptions(r.options),
    };
}
