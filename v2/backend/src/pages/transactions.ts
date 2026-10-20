import type pg from 'pg';
import {filterSql, type Filters} from '../lib/filters.js';
import {comparisonRange, maxDate, minDate, type IsoDate} from '../lib/period.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import {FILTER_OPTIONS_SQL, filterOptions, PAGE_ROWS_CTE, type FilterOptions, type RawFilterOptions} from '../queries/page-rows.js';

// Transactions (/transactions and /c-hub/transactions). Reproduces the Python
// app's transactions handler: high-value transactions of the chosen types at
// or above a threshold.

export interface TransactionsInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    filters: Filters;
    // Transaction types to list (Python default: tip and message).
    types: string[];
    // Minimum amount in EUR (Python default: settings unlock_threshold).
    threshold: number;
    eurUsdRate?: number;
}

export interface HighValueTransaction {
    creator: string | null;
    date: IsoDate;
    // As the Python app prints it: UTC, "YYYY-MM-DD HH:MM:SS.ffffff+00:00".
    timestamp: string;
    amount: number;
    transactionType: string | null;
    chatter: string | null;
    chatterStatus: 'Assigned' | 'Missing / Unassigned';
    platform: string | null;
}

export interface Transactions {
    period: {start: IsoDate; end: IsoDate; compare: string; compareStart: IsoDate; compareEnd: IsoDate};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    threshold: number;
    types: string[];
    rows: HighValueTransaction[];
    filterOptions: FilterOptions;
}

interface QueryResult {
    currentRows: number;
    previousRows: number;
    revenue: number;
    previousRevenue: number;
    // Whether the filtered period has revenue attributed to a creator or chatter.
    hasEntityRevenue: boolean;
    rows: HighValueTransaction[] | null;
    options: RawFilterOptions;
}

function querySql(filters: Filters, params: unknown[]): string {
    const where = filterSql(filters, params);
    return `
WITH ${PAGE_ROWS_CTE},
current_rows AS (SELECT * FROM page_rows WHERE date BETWEEN $4 AND $5 AND ${where}),
previous_rows AS (SELECT * FROM page_rows WHERE date BETWEEN $6 AND $7 AND ${where}),
high_value AS (
    SELECT tx.*,
           -- Python app: unlock amount when positive, otherwise revenue (both in EUR).
           CASE WHEN tx.unlock_amount > 0 THEN tx.unlock_amount ELSE tx.revenue END
               / CASE tx.currency WHEN 'USD' THEN $3 ELSE 1 END AS amount
    FROM tx
    WHERE tx.date BETWEEN $4 AND $5 AND ${where}
      AND tx.transaction_type = ANY($8::text[])
)
SELECT json_build_object(
    'currentRows', (SELECT count(*) FROM current_rows),
    'previousRows', (SELECT count(*) FROM previous_rows),
    'revenue', (SELECT COALESCE(sum(revenue), 0) FROM current_rows),
    'previousRevenue', (SELECT COALESCE(sum(revenue), 0) FROM previous_rows),
    'hasEntityRevenue', EXISTS (
        SELECT 1 FROM current_rows
        WHERE revenue > 0 AND (btrim(COALESCE(creator, '')) <> '' OR btrim(COALESCE(chatter, '')) <> '')
    ),
    'rows', (SELECT json_agg(json_build_object(
        'creator', creator,
        'date', date,
        'timestamp', to_char(timestamp AT TIME ZONE 'UTC',
                             CASE WHEN extract(microseconds FROM timestamp)::bigint % 1000000 = 0
                                  THEN 'YYYY-MM-DD HH24:MI:SS' ELSE 'YYYY-MM-DD HH24:MI:SS.US' END) || '+00:00',
        'amount', amount,
        'transactionType', transaction_type,
        'chatter', chatter,
        'chatterStatus', CASE WHEN btrim(COALESCE(chatter, '')) = '' THEN 'Missing / Unassigned' ELSE 'Assigned' END,
        'platform', platform
    ) ORDER BY amount DESC, timestamp DESC) FROM high_value WHERE amount >= $9),
    'options', ${FILTER_OPTIONS_SQL}
) AS result`;
}

export async function transactions(pool: pg.Pool, input: TransactionsInput): Promise<Transactions> {
    const {start, end, compare, filters, types, threshold} = input;
    const [compareStart, compareEnd] = comparisonRange(start, end, compare);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const params: unknown[] = [minDate(start, compareStart), maxDate(end, compareEnd), rate, start, end, compareStart, compareEnd, types, threshold];
    const q = (await pool.query<{result: QueryResult}>(querySql(filters, params), params)).rows[0].result;
    return {
        period: {start, end, compare, compareStart, compareEnd},
        eurUsdRate: rate,
        comparison: {
            currentRevenue: q.currentRows ? q.revenue : null,
            previousRevenue: q.previousRows ? q.previousRevenue : null,
        },
        threshold,
        types,
        // The Python app shows no rows when nothing is attributed to anyone.
        rows: q.hasEntityRevenue ? q.rows ?? [] : [],
        filterOptions: filterOptions(q.options),
    };
}
