import type pg from 'pg';
import {filterSql, type Filters} from '../lib/filters.js';
import {comparisonRange, maxDate, minDate, previousMonthSameDays, shortRangeLabel, type IsoDate} from '../lib/period.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import {
    FILTER_OPTIONS_SQL, filterOptions, namedSql, PAGE_ROWS_CTE, revenueTrend, type FilterOptions, type RawFilterOptions, type TrendDay,
} from '../queries/page-rows.js';

// Executive Overview (/c-hub/executive-overview). Reproduces the Python
// app's RevenueAnalyticsHandler.overview for the Postgres data source; every
// number is computed in Postgres and only the results are returned.

export interface ExecutiveOverviewInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    filters: Filters;
    // Business date for the month-to-date trend (settings timezone).
    today: IsoDate;
    // Fixed EUR/USD rate; by default Flow's current rate, as in the Python app.
    // Used to compare with numbers captured when the rate was different.
    eurUsdRate?: number;
}

export type {TrendDay};

export interface ExecutiveOverview {
    period: {start: IsoDate; end: IsoDate; compare: string; compareStart: IsoDate; compareEnd: IsoDate};
    eurUsdRate: number;
    metrics: {
        totalRevenue: number;
        previousRevenue: number;
        revenueChangePct: number | null;
        flowManagerGross: number | null;
        flowManagerNet: number | null;
        revenuePerHour: number | null;
        activeChatters: number;
        activeCreators: number;
        totalHours: number;
        totalInactivityMinutes: number | null;
        medianPerChatter: number | null;
        avgPerCreator: number | null;
    };
    // Comparison strip: null when the period has no rows at all (Python: empty frame).
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    revenueByType: {transactionType: string | null; revenue: number; days: number; rows: number}[];
    trend: {start: IsoDate; today: IsoDate; current: TrendDay[]; previous: TrendDay[]; previousLabel: string};
    // Values offered by the filter bar (from all loaded rows, unfiltered).
    filterOptions: FilterOptions;
}

function metricsSql(filters: Filters, params: unknown[]): string {
    const allFilters = filterSql(filters, params);
    // Hours use every shift filter except transaction type (Python: scheduled_shift_rows).
    const shiftFilters = filterSql(filters, params, ['platform', 'team', 'creator', 'chatter']);
    return `
WITH ${PAGE_ROWS_CTE},
current_rows AS (SELECT * FROM page_rows WHERE date BETWEEN $4 AND $5 AND ${allFilters}),
previous_rows AS (SELECT * FROM page_rows WHERE date BETWEEN $6 AND $7 AND ${allFilters}),
worked_shifts AS (
    SELECT shift_id, max(shift_hours) AS hours
    FROM page_rows
    WHERE date BETWEEN $4 AND $5 AND transaction_type = 'shift_summary' AND ${shiftFilters}
      AND ${namedSql('chatter')} AND COALESCE(shift_hours, 0) > 0
    GROUP BY shift_id
),
chatter_totals AS (
    SELECT btrim(chatter) AS chatter, sum(COALESCE(revenue, 0)) AS revenue
    FROM current_rows WHERE ${namedSql('chatter')}
    GROUP BY 1
),
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
    'workedShiftCount', (SELECT count(*) FROM worked_shifts),
    'workedShiftHours', (SELECT COALESCE(sum(hours), 0) FROM worked_shifts),
    'allShiftHours', (SELECT COALESCE(sum(shift_hours), 0) FROM current_rows),
    'inactivityMinutes', (SELECT sum(inactive_minutes) FROM current_rows),
    'activeChatters', (SELECT count(DISTINCT NULLIF(chatter, '')) FROM current_rows),
    'activeCreators', (SELECT count(DISTINCT NULLIF(creator, '')) FROM current_rows),
    'medianPerChatter', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY revenue) FROM chatter_totals WHERE revenue > 0),
    'options', ${FILTER_OPTIONS_SQL},
    'unsupportedCurrencies', (SELECT array_agg(DISTINCT currency) FROM page_rows WHERE currency IS NOT NULL AND currency NOT IN ('USD', 'EUR')),
    'byType', (SELECT COALESCE(json_agg(json_build_object(
        'transactionType', transaction_type, 'revenue', revenue, 'days', days, 'rows', rows
    ) ORDER BY revenue DESC), '[]'::json) FROM by_type)
) AS result`;
}

interface MetricsRow {
    currentRows: number;
    previousRows: number;
    revenue: number;
    previousRevenue: number;
    workedShiftCount: number;
    workedShiftHours: number;
    allShiftHours: number;
    inactivityMinutes: number | null;
    activeChatters: number;
    activeCreators: number;
    medianPerChatter: number | null;
    options: RawFilterOptions;
    unsupportedCurrencies: string[] | null;
    byType: {transactionType: string | null; revenue: number; days: number; rows: number}[];
}

// Flow Manager Gross / Net from Flow's company-visible transaction view: only
// tips, messages and subscriptions with a non-zero net amount (Python:
// flow_manager_dashboard_totals). Platform and transaction-type filters apply;
// the view has no team, creator or chatter names, so those filters do not.
async function flowManagerTotals(pool: pg.Pool, start: IsoDate, end: IsoDate, rate: number, filters: Filters) {
    const params: unknown[] = [start, end, rate];
    const where = filterSql(filters, params, ['platform', 'transaction_type']);
    const result = await pool.query<{rows: string; gross: number | null; net: number | null}>(`
        WITH visible AS (
            SELECT upper(t.platform) AS platform,
                   lower(t.type) AS transaction_type,
                   t.gross_amount::float AS revenue,
                   t.net_amount::float AS net_amount,
                   COALESCE(NULLIF(upper(btrim(t.currency)), ''),
                            CASE upper(t.platform) WHEN 'OF' THEN 'USD' WHEN 'KNKY' THEN 'USD' ELSE 'EUR' END) AS currency
            FROM visible_transactions t
            WHERE t.occurred_at >= ($1::date)::timestamp AT TIME ZONE 'Europe/Sarajevo'
              AND t.occurred_at < ($2::date + 1)::timestamp AT TIME ZONE 'Europe/Sarajevo'
              -- Flow's Manager Dashboard does not count records still marked done.
              AND lower(COALESCE(t.status, '')) <> 'done'
        ),
        converted AS (
            SELECT transaction_type,
                   CASE currency WHEN 'USD' THEN revenue / $3 ELSE revenue END AS revenue,
                   CASE currency WHEN 'USD' THEN net_amount / $3 ELSE net_amount END AS net_amount
            FROM visible WHERE ${where}
        )
        SELECT count(*) AS rows,
               COALESCE(sum(revenue) FILTER (WHERE eligible), 0) AS gross,
               COALESCE(sum(net_amount) FILTER (WHERE eligible), 0) AS net
        FROM (
            SELECT *, net_amount IS NOT NULL AND net_amount <> 0
                      AND btrim(transaction_type) IN ('tip', 'message', 'subscription') AS eligible
            FROM converted
        ) x`, params);
    const row = result.rows[0];
    if (!row || Number(row.rows) === 0) return {gross: null, net: null};
    return {gross: Number(row.gross), net: Number(row.net)};
}

export async function executiveOverview(pool: pg.Pool, input: ExecutiveOverviewInput): Promise<ExecutiveOverview> {
    const {start, end, compare, filters, today} = input;
    const [compareStart, compareEnd] = comparisonRange(start, end, compare);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);

    const params: unknown[] = [minDate(start, compareStart), maxDate(end, compareEnd), rate, start, end, compareStart, compareEnd];
    const sql = metricsSql(filters, params);

    const mtdStart = `${today.slice(0, 8)}01`;
    const [previousStart, previousEnd] = previousMonthSameDays(mtdStart, today);

    const [metricsResult, manager, currentTrend, previousTrend] = await Promise.all([
        pool.query<{result: MetricsRow}>(sql, params),
        flowManagerTotals(pool, start, end, rate, filters),
        revenueTrend(pool, mtdStart, today, rate),
        revenueTrend(pool, previousStart, previousEnd, rate),
    ]);
    const m = metricsResult.rows[0].result;
    if (m.unsupportedCurrencies?.length) {
        throw new Error(`Unsupported transaction currency: ${m.unsupportedCurrencies.join(', ')}`);
    }

    // Python: executive_metrics, then apply_scheduled_hours (worked shifts with a
    // named chatter replace the plain shift-hour sum when there are any).
    const totalHours = m.workedShiftCount > 0 ? m.workedShiftHours : m.allShiftHours;
    return {
        period: {start, end, compare, compareStart, compareEnd},
        eurUsdRate: rate,
        metrics: {
            totalRevenue: m.revenue,
            previousRevenue: m.previousRevenue,
            revenueChangePct: m.previousRevenue ? (m.revenue - m.previousRevenue) / m.previousRevenue * 100 : null,
            flowManagerGross: manager.gross,
            flowManagerNet: manager.net,
            revenuePerHour: totalHours ? m.revenue / totalHours : null,
            activeChatters: m.activeChatters,
            activeCreators: m.activeCreators,
            totalHours,
            totalInactivityMinutes: m.inactivityMinutes,
            medianPerChatter: m.medianPerChatter,
            avgPerCreator: m.activeCreators ? m.revenue / m.activeCreators : null,
        },
        comparison: {
            currentRevenue: m.currentRows ? m.revenue : null,
            previousRevenue: m.previousRows ? m.previousRevenue : null,
        },
        revenueByType: m.byType,
        trend: {
            start: mtdStart,
            today,
            current: currentTrend,
            previous: previousTrend,
            previousLabel: shortRangeLabel(previousStart, previousEnd),
        },
        filterOptions: filterOptions(m.options),
    };
}
