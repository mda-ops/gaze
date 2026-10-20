import type pg from 'pg';
import {filterSql, type Filters} from '../lib/filters.js';
import {comparisonRange, maxDate, minDate, type IsoDate} from '../lib/period.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import {FILTER_OPTIONS_SQL, filterOptions, PAGE_ROWS_CTE, type FilterOptions, type RawFilterOptions} from '../queries/page-rows.js';

// The Core analysis pages /revenue, /chatters, /creators and /platforms.
// Reproduces the Python app's group_performance, creator_performance and
// revenue_type_breakdown over the selected period's rows.

export type Group = 'creator' | 'chatter' | 'platform';

export interface CoreAnalysisInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    filters: Filters;
    // The groupings the page shows.
    groups: Group[];
    // Fixed EUR/USD rate for comparisons with captured numbers.
    eurUsdRate?: number;
}

// One row of group_performance; the column names are the Python ones.
export interface GroupRow {
    key: string;
    revenue: number;
    hours: number;
    messages: number;
    inactivity: number;
    transactions: number;
    creators_worked: number;
    days: number;
    previous_revenue: number;
    change_amount: number;
    change_pct: number | null;
    revenue_per_hour: number | null;
    messages_per_hour: number | null;
    revenue_share_pct: number | null;
    average_revenue_per_day: number | null;
    average_transaction_value: number | null;
}

// creator_performance adds these. They are null for a creator group the
// extras do not match (Python: the merge leaves NaN).
export interface CreatorExtras {
    active_chatters: number | null;
    unlock_revenue: number | null;
    tip_revenue: number | null;
    subscription_revenue: number | null;
    revenue_per_chatter: number | null;
}

export interface CoreAnalysis {
    period: {start: IsoDate; end: IsoDate; compare: string; compareStart: IsoDate; compareEnd: IsoDate};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    // Python: has_entity_revenue / has_real_platform_revenue. False shows the
    // page's data coverage note and an empty table.
    coverage: {creator: boolean; chatter: boolean; platform: boolean};
    revenueByType: {transaction_type: string | null; revenue: number; days: number; rows: number}[];
    groups: Partial<Record<Group, GroupRow[]>>;
    creatorExtras: (GroupRow & CreatorExtras)[] | null;
    // Revenue per named chatter, highest first (Python: top_n_concentration).
    chatterTotals: number[];
    filterOptions: FilterOptions;
}

// fillna("Unknown").replace("", "Unknown"): only NULL and the exact empty string.
const groupKey = (column: Group) => `CASE WHEN ${column} IS NULL OR ${column} = '' THEN 'Unknown' ELSE ${column} END`;

function groupSql(group: Group): string {
    // creators_worked counts the creator column; when grouping by creator that is
    // the filled key, so it is always 1.
    const creators = group === 'creator' ? groupKey('creator') : 'creator';
    return `(SELECT COALESCE(json_agg(json_build_object(
        'key', c.key, 'revenue', c.revenue, 'hours', c.hours, 'inactivity', c.inactivity, 'transactions', c.transactions,
        'creators_worked', c.creators_worked, 'days', c.days, 'previous_revenue', COALESCE(p.revenue, 0)
    )), '[]'::json)
    FROM (
        SELECT ${groupKey(group)} AS key,
               COALESCE(sum(revenue), 0) AS revenue,
               COALESCE(sum(shift_hours), 0) AS hours,
               COALESCE(sum(inactive_minutes), 0) AS inactivity,
               count(revenue) AS transactions,
               count(DISTINCT ${creators}) AS creators_worked,
               count(DISTINCT date) AS days
        FROM current_rows GROUP BY 1
    ) c
    LEFT JOIN (SELECT ${groupKey(group)} AS key, sum(revenue) AS revenue FROM previous_rows GROUP BY 1) p USING (key))`;
}

// Python's `x if x else None`.
const ratio = (a: number, b: number) => (b ? a / b : null);

// Python sorts by revenue descending with an unstable sort, so the order of
// equal revenues is arbitrary there; here they are ordered by name.
function byRevenue<T extends {key: string; revenue: number}>(rows: T[]): T[] {
    return [...rows].sort((a, b) => b.revenue - a.revenue || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

interface RawGroup {
    key: string; revenue: number; hours: number; inactivity: number; transactions: number;
    creators_worked: number; days: number; previous_revenue: number;
}

function groupPerformance(raw: RawGroup[]): GroupRow[] {
    const total = raw.reduce((sum, r) => sum + r.revenue, 0);
    return byRevenue(raw.map(r => ({
        key: r.key,
        revenue: r.revenue,
        hours: r.hours,
        // messages_sent is never filled for the Postgres source.
        messages: 0,
        inactivity: r.inactivity,
        transactions: r.transactions,
        creators_worked: r.creators_worked,
        days: r.days,
        previous_revenue: r.previous_revenue,
        change_amount: r.revenue - r.previous_revenue,
        change_pct: r.previous_revenue ? (r.revenue - r.previous_revenue) / r.previous_revenue * 100 : null,
        revenue_per_hour: ratio(r.revenue, r.hours),
        messages_per_hour: ratio(0, r.hours),
        revenue_share_pct: total ? r.revenue / total * 100 : null,
        average_revenue_per_day: ratio(r.revenue, r.days),
        average_transaction_value: ratio(r.revenue, r.transactions),
    })));
}

interface ResultRow {
    currentRows: number;
    previousRows: number;
    revenue: number;
    previousRevenue: number;
    coverage: {creator: boolean; chatter: boolean; platform: boolean};
    byType: CoreAnalysis['revenueByType'];
    groups: Partial<Record<Group, RawGroup[]>>;
    extras: {creator: string; active_chatters: number; unlock_revenue: number; tip_revenue: number; subscription_revenue: number}[] | null;
    chatterTotals: number[];
    options: RawFilterOptions;
    unsupportedCurrencies: string[] | null;
}

export async function coreAnalysis(pool: pg.Pool, input: CoreAnalysisInput): Promise<CoreAnalysis> {
    const {start, end, compare, filters, groups} = input;
    const [compareStart, compareEnd] = comparisonRange(start, end, compare);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const params: unknown[] = [minDate(start, compareStart), maxDate(end, compareEnd), rate, start, end, compareStart, compareEnd];
    const where = filterSql(filters, params);
    const named = (column: string) => `${column} IS NOT NULL AND btrim(${column}) <> ''`;
    const withExtras = groups.includes('creator');

    const result = await pool.query<{result: ResultRow}>(`
WITH ${PAGE_ROWS_CTE},
current_rows AS MATERIALIZED (SELECT * FROM page_rows WHERE date BETWEEN $4 AND $5 AND ${where}),
previous_rows AS (SELECT * FROM page_rows WHERE date BETWEEN $6 AND $7 AND ${where}),
by_type AS (
    SELECT transaction_type, COALESCE(sum(revenue), 0) AS revenue, count(DISTINCT date) AS days, count(revenue) AS rows
    FROM current_rows
    WHERE btrim(COALESCE(transaction_type, '')) NOT IN ('shift_summary', 'summary')
    GROUP BY transaction_type
)
SELECT json_build_object(
    'currentRows', (SELECT count(*) FROM current_rows),
    'previousRows', (SELECT count(*) FROM previous_rows),
    'revenue', (SELECT COALESCE(sum(revenue), 0) FROM current_rows),
    'previousRevenue', (SELECT COALESCE(sum(revenue), 0) FROM previous_rows),
    'coverage', json_build_object(
        'creator', EXISTS (SELECT 1 FROM current_rows WHERE ${named('creator')} AND revenue > 0),
        'chatter', EXISTS (SELECT 1 FROM current_rows WHERE ${named('chatter')} AND revenue > 0),
        'platform', EXISTS (SELECT 1 FROM current_rows WHERE revenue > 0)
            AND EXISTS (SELECT 1 FROM current_rows WHERE platform IS NOT NULL AND btrim(platform) <> 'Revenue Catcher')
    ),
    -- Python sorts the groupby result (type order, missing last) by revenue; equal
    -- revenues keep that order.
    'byType', (SELECT COALESCE(json_agg(json_build_object(
        'transaction_type', transaction_type, 'revenue', revenue, 'days', days, 'rows', rows
    ) ORDER BY revenue DESC, transaction_type COLLATE "C" NULLS LAST), '[]'::json) FROM by_type),
    'groups', json_build_object(${groups.map(g => `'${g}', ${groupSql(g)}`).join(', ')}),
    -- creator_performance groups the unfilled creator column.
    'extras', ${withExtras ? `(SELECT json_agg(json_build_object(
        'creator', creator, 'active_chatters', count, 'unlock_revenue', unlock, 'tip_revenue', tip, 'subscription_revenue', subscription
    )) FROM (
        SELECT creator, count(DISTINCT chatter) AS count, COALESCE(sum(unlock_amount), 0) AS unlock,
               COALESCE(sum(tip_revenue), 0) AS tip, COALESCE(sum(subscription_revenue), 0) AS subscription
        FROM current_rows WHERE creator IS NOT NULL GROUP BY creator
    ) e)` : 'NULL'},
    'chatterTotals', (SELECT COALESCE(json_agg(revenue ORDER BY revenue DESC), '[]'::json) FROM (
        SELECT COALESCE(sum(revenue), 0) AS revenue FROM current_rows WHERE chatter IS NOT NULL GROUP BY chatter
    ) t),
    'options', ${FILTER_OPTIONS_SQL},
    'unsupportedCurrencies', (SELECT array_agg(DISTINCT currency) FROM page_rows WHERE currency IS NOT NULL AND currency NOT IN ('USD', 'EUR'))
) AS result`, params);
    const r = result.rows[0].result;
    if (r.unsupportedCurrencies?.length) {
        throw new Error(`Unsupported transaction currency: ${r.unsupportedCurrencies.join(', ')}`);
    }

    const performance: Partial<Record<Group, GroupRow[]>> = {};
    for (const g of groups) performance[g] = groupPerformance(r.groups[g] ?? []);

    let creatorExtras: CoreAnalysis['creatorExtras'] = null;
    if (withExtras) {
        const extras = new Map((r.extras ?? []).map(e => [e.creator, e]));
        creatorExtras = performance.creator!.map(row => {
            const e = extras.get(row.key);
            return {
                ...row,
                active_chatters: e?.active_chatters ?? null,
                unlock_revenue: e?.unlock_revenue ?? null,
                tip_revenue: e?.tip_revenue ?? null,
                subscription_revenue: e?.subscription_revenue ?? null,
                revenue_per_chatter: e ? ratio(row.revenue, e.active_chatters) : null,
            };
        });
    }

    return {
        period: {start, end, compare, compareStart, compareEnd},
        eurUsdRate: rate,
        comparison: {
            currentRevenue: r.currentRows ? r.revenue : null,
            previousRevenue: r.previousRows ? r.previousRevenue : null,
        },
        coverage: r.coverage,
        revenueByType: r.byType,
        groups: performance,
        creatorExtras,
        chatterTotals: r.chatterTotals,
        filterOptions: filterOptions(r.options),
    };
}
