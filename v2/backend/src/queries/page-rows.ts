import type pg from 'pg';
import {eachDay, type IsoDate} from '../lib/period.js';
import {INACTIVITY_ROWS_SQL, SHIFT_ROWS_SQL} from './activity.js';
import {TRANSACTIONS_SQL} from './transactions.js';

// Building blocks shared by the analysis pages.

// SQL CTEs "tx" and "page_rows": every row of a load range ($1..$2) as the
// Python app's analytics frame holds them. Revenue rows are converted to EUR
// with the EUR/USD rate in $3, as are the per-type amounts (ppv, tip,
// subscription); shift and inactivity rows have no revenue.
// MATERIALIZED so the heavy transaction query runs once per request.
export const PAGE_ROWS_CTE = `
tx AS (${TRANSACTIONS_SQL}),
page_rows AS MATERIALIZED (
    SELECT date, creator, chatter, platform, team, transaction_type,
           CASE currency WHEN 'USD' THEN revenue / $3 WHEN 'EUR' THEN revenue END AS revenue,
           currency,
           NULL::float AS shift_hours, NULL::text AS shift_id, NULL::float AS inactive_minutes,
           CASE currency WHEN 'USD' THEN unlock_amount / $3 WHEN 'EUR' THEN unlock_amount END AS unlock_amount,
           CASE currency WHEN 'USD' THEN tip_revenue / $3 WHEN 'EUR' THEN tip_revenue END AS tip_revenue,
           CASE currency WHEN 'USD' THEN subscription_revenue / $3 WHEN 'EUR' THEN subscription_revenue END AS subscription_revenue
    FROM tx
    UNION ALL
    SELECT date, creator, chatter, platform, team, transaction_type,
           NULL::float, NULL::text, shift_hours, shift_id, NULL::float, NULL::float, NULL::float, NULL::float
    FROM (${SHIFT_ROWS_SQL}) shift_rows
    UNION ALL
    SELECT date, creator, chatter, platform, team, transaction_type,
           NULL::float, NULL::text, NULL::float, NULL::text, inactive_minutes, NULL::float, NULL::float, NULL::float
    FROM (${INACTIVITY_ROWS_SQL}) inactivity_rows
)`;

// A name that counts as missing in the Python app ('', 'unknown', 'none', 'nan').
export function namedSql(column: string): string {
    return `btrim(COALESCE(${column}, '')) <> '' AND lower(btrim(${column})) NOT IN ('unknown', 'none', 'nan')`;
}

// SQL version of platformLabel() below, for grouping in the database.
export function platformLabelSql(column: string): string {
    const key = `lower(btrim(COALESCE(${column}, '')))`;
    return `CASE
        WHEN ${key} LIKE '%f2f%' THEN 'F2F'
        WHEN ${key} LIKE '%knky%' OR ${key} LIKE '%kinky%' THEN 'KNKY'
        WHEN ${key} = 'of' OR ${key} LIKE '%onlyfans%' OR ${key} = 'only fans' THEN 'OF'
        ELSE COALESCE(NULLIF(btrim(${column}), ''), 'Unknown')
    END`;
}

// Python: platform_display_name.
export function platformLabel(platform: string | null): string {
    const raw = (platform ?? '').trim();
    const key = raw.toLowerCase();
    if (key.includes('f2f')) return 'F2F';
    if (key.includes('knky') || key.includes('kinky')) return 'KNKY';
    if (key === 'of' || key.includes('onlyfans') || key === 'only fans') return 'OF';
    return raw || 'Unknown';
}

export const CORE_PLATFORMS = ['F2F', 'KNKY', 'OF'] as const;
export const PLATFORM_ORDER: Record<string, number> = {F2F: 0, KNKY: 1, OF: 2};

export function platformOrder(platform: string): number {
    return PLATFORM_ORDER[platform] ?? 9;
}

// Python's sorted(): plain code-point order, not the database collation.
export function codePointSort(values: string[]): string[] {
    return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Python's sorted(key=str.lower).
export function caseInsensitiveSort(values: string[]): string[] {
    return [...values].sort((a, b) => {
        const x = a.toLowerCase();
        const y = b.toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
    });
}

export interface TrendDay {
    date: IsoDate;
    revenue: number;
    platforms: {platform: string; revenue: number}[];
}

// Daily revenue with per-platform splits (Python: daily_trend_rows), optionally
// limited to some transaction types. Needs only date, platform and amount, so it
// reads transactions directly: the same rows as the enriched query, without the
// per-row lookups.
export async function revenueTrend(pool: pg.Pool, start: IsoDate, end: IsoDate, rate: number, types: string[] | null = null): Promise<TrendDay[]> {
    const result = await pool.query<{date: string; platform: string | null; revenue: number; positive: number}>(`
        SELECT timezone('Europe/Sarajevo', t.occurred_at)::date::text AS date,
               upper(t.platform) AS platform,
               sum(CASE WHEN c.currency = 'USD' THEN t.gross_amount::float / $3 ELSE t.gross_amount::float END) AS revenue,
               COALESCE(sum(CASE WHEN c.currency = 'USD' THEN t.gross_amount::float / $3 ELSE t.gross_amount::float END)
                        FILTER (WHERE t.gross_amount > 0), 0) AS positive
        FROM transactions t
        CROSS JOIN LATERAL (
            SELECT COALESCE(NULLIF(upper(trim(t.currency)), ''), CASE WHEN lower(t.platform) IN ('of', 'knky') THEN 'USD' ELSE 'EUR' END) AS currency
        ) c
        WHERE t.occurred_at >= ($1::date)::timestamp AT TIME ZONE 'Europe/Sarajevo'
          AND t.occurred_at < ($2::date + 1)::timestamp AT TIME ZONE 'Europe/Sarajevo'
          AND COALESCE(t.gross_amount, 0) <> 0
          AND lower(COALESCE(t.status, '')) <> 'done'
          AND ($4::text[] IS NULL OR COALESCE(lower(t.type), 'Unknown') = ANY($4::text[]))
        GROUP BY 1, 2`, [start, end, rate, types]);

    const totals = new Map<string, number>();
    const splits = new Map<string, Map<string, number>>();
    for (const row of result.rows) {
        totals.set(row.date, (totals.get(row.date) ?? 0) + Number(row.revenue));
        if (Number(row.positive) > 0) {
            const day = splits.get(row.date) ?? new Map<string, number>();
            const label = platformLabel(row.platform);
            day.set(label, (day.get(label) ?? 0) + Number(row.positive));
            splits.set(row.date, day);
        }
    }
    return eachDay(start, end).map(date => {
        const revenue = totals.get(date) ?? 0;
        const platforms = [...(splits.get(date) ?? new Map()).entries()]
            .map(([platform, value]) => ({platform, revenue: value}))
            .sort((a, b) => platformOrder(a.platform) - platformOrder(b.platform) || b.revenue - a.revenue);
        const splitTotal = platforms.reduce((sum, p) => sum + p.revenue, 0);
        if (revenue > splitTotal && splitTotal > 0 && revenue - splitTotal > 0.01) {
            platforms.push({platform: 'Other', revenue: revenue - splitTotal});
        }
        return {date, revenue, platforms};
    });
}

// Choices of the analysis filter bar, from every loaded row (Python app:
// filter_bar over the analytics frame). Use as a json_build_object value in a
// query over page_rows; pass the result to filterOptions().
export const FILTER_OPTIONS_SQL = `json_build_object(
        'platform', (SELECT array_agg(DISTINCT platform) FROM page_rows WHERE platform IS NOT NULL),
        'team', (SELECT array_agg(DISTINCT team) FROM page_rows WHERE team IS NOT NULL),
        'creator', (SELECT array_agg(DISTINCT creator) FROM page_rows WHERE creator IS NOT NULL),
        'chatter', (SELECT array_agg(DISTINCT chatter) FROM page_rows WHERE chatter IS NOT NULL),
        'transaction_type', (SELECT array_agg(DISTINCT btrim(transaction_type)) FROM page_rows WHERE transaction_type IS NOT NULL)
    )`;

export type FilterOptions = Record<'platform' | 'team' | 'creator' | 'chatter' | 'transaction_type', string[]>;
export type RawFilterOptions = Record<keyof FilterOptions, string[] | null>;

export function filterOptions(options: RawFilterOptions): FilterOptions {
    const teams = options.team ?? [];
    const lower = new Set(teams.map(t => t.toLowerCase()));
    // The team list always offers Dutch and English.
    const withDefaults = [...teams, ...['Dutch', 'English'].filter(t => !lower.has(t.toLowerCase()))];
    const hidden = new Set(['shift_summary', 'summary', 'inactivity', '']);
    return {
        platform: codePointSort(options.platform ?? []),
        team: caseInsensitiveSort(withDefaults),
        creator: codePointSort(options.creator ?? []),
        chatter: codePointSort(options.chatter ?? []),
        transaction_type: codePointSort((options.transaction_type ?? []).filter(t => !hidden.has(t))),
    };
}
