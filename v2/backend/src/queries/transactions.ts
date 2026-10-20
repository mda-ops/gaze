import type pg from 'pg';

// Revenue transactions for a business-date range (Europe/Sarajevo), one row
// per Flow transaction, enriched with chatter, team, commission and manager.
//
// Same columns and rules as the Python app's TRANSACTION_SQL
// (queries/legacy/transactions.legacy.sql); transactions.parity.test.ts
// checks the two return identical rows. Two differences, both for speed:
//
// 1. The date range is applied to occurred_at before any join, as a
//    timestamp range, so the transactions index can be used. A business date
//    D covers [D 00:00, D+1 00:00) Sarajevo time, so this matches
//    `timezone('Europe/Sarajevo', occurred_at)::date BETWEEN start AND end`
//    exactly, DST included.
// 2. Transactions without a chatter_id get their chatter from the shift
//    covering them (same creator and platform, latest clock_in wins). This is
//    done in one join against the shifts that overlap the range, instead of
//    once per transaction over the creator's whole shift history, and is
//    skipped for transactions that already carry a chatter_id.
export const TRANSACTIONS_SQL = `
WITH bounds AS (
    SELECT ($1::date)::timestamp AT TIME ZONE 'Europe/Sarajevo' AS range_start,
           ($2::date + 1)::timestamp AT TIME ZONE 'Europe/Sarajevo' AS range_end
),
tx AS (
    SELECT t.*
    FROM transactions t, bounds b
    WHERE t.occurred_at >= b.range_start
      AND t.occurred_at < b.range_end
      AND COALESCE(t.gross_amount, 0) <> 0
      -- Revenue Catcher's manager totals exclude records still marked "done".
      AND lower(COALESCE(t.status, '')) <> 'done'
),
candidate_shifts AS (
    SELECT s.id, s.creator_id, lower(s.platform) AS platform, s.clock_in,
           COALESCE(s.clock_out, now()) AS clock_out, s.chatter_id
    FROM shifts s, bounds b
    WHERE s.clock_in < b.range_end
      AND COALESCE(s.clock_out, now()) >= b.range_start
),
shift_match AS (
    SELECT DISTINCT ON (tx.id) tx.id AS transaction_id, cs.chatter_id
    FROM tx
    JOIN candidate_shifts cs
      ON cs.creator_id = tx.creator_id
     AND cs.platform = lower(tx.platform)
     AND tx.occurred_at >= cs.clock_in
     AND tx.occurred_at <= cs.clock_out
    WHERE tx.chatter_id IS NULL
    -- Two shifts can start at the same instant on one account (two chatters
    -- on 2026-07-30); the lower shift id wins so the result is stable.
    ORDER BY tx.id, cs.clock_in DESC, cs.id
),
enriched AS (
    SELECT
        t.id,
        timezone('Europe/Sarajevo', t.occurred_at)::date AS local_date,
        t.occurred_at,
        t.creator_id,
        COALESCE(c.name, ca.username) AS creator_name,
        COALESCE(t.chatter_id, shift_match.chatter_id) AS resolved_chatter_id,
        COALESCE(u.name, shift_user.name) AS resolved_chatter_name,
        team_match.name AS resolved_team,
        rate_match.pct::float AS flow_chatter_commission_pct,
        manager_match.pct::float AS flow_manager_commission_pct,
        manager_match.manager_name AS flow_manager_name,
        rate_match.pool_name AS flow_commission_pool,
        t.creator_account_id,
        ca.username AS account_username,
        t.platform,
        t.type,
        t.status,
        t.gross_amount,
        t.net_amount,
        COALESCE(NULLIF(upper(trim(t.currency)), ''), CASE WHEN lower(t.platform) IN ('of', 'knky') THEN 'USD' ELSE 'EUR' END) AS currency,
        t.platform_transaction_id,
        t.fan_username,
        t.attribution_source
    FROM tx t
    LEFT JOIN creators c ON c.id = t.creator_id
    LEFT JOIN creator_accounts ca ON ca.id = t.creator_account_id
    LEFT JOIN users u ON u.id = t.chatter_id
    LEFT JOIN shift_match ON shift_match.transaction_id = t.id
    LEFT JOIN users shift_user ON shift_user.id = shift_match.chatter_id
    -- Team membership is effective-dated in Flow: resolve it on the
    -- transaction's date so historical revenue stays with its actual team.
    LEFT JOIN LATERAL (
        SELECT team.id AS team_id, team.name
        FROM chatter_team_assignments cta
        JOIN teams team ON team.id = cta.team_id
        WHERE cta.chatter_id = COALESCE(t.chatter_id, shift_match.chatter_id)
          AND (cta.effective_from IS NULL OR cta.effective_from <= timezone('Europe/Sarajevo', t.occurred_at)::date)
          AND (cta.effective_until IS NULL OR cta.effective_until >= timezone('Europe/Sarajevo', t.occurred_at)::date)
        ORDER BY cta.effective_from DESC NULLS LAST, cta.created_at DESC
        LIMIT 1
    ) team_match ON TRUE
    -- Chatter rate per chatter / creator / platform. Prefer a rate active on
    -- the transaction date; otherwise fall back to the latest earlier rate.
    LEFT JOIN LATERAL (
        SELECT ccr.pct, pool.name AS pool_name
        FROM chatter_commission_rates ccr
        LEFT JOIN commission_pools pool ON pool.id = ccr.pool_id
        WHERE ccr.chatter_id = COALESCE(t.chatter_id, shift_match.chatter_id)
          AND ccr.creator_id = t.creator_id
          AND lower(ccr.platform) = lower(t.platform)
          AND (ccr.effective_from IS NULL OR ccr.effective_from <= timezone('Europe/Sarajevo', t.occurred_at)::date)
        ORDER BY
            CASE WHEN ccr.effective_until IS NULL OR ccr.effective_until >= timezone('Europe/Sarajevo', t.occurred_at)::date THEN 0 ELSE 1 END,
            ccr.effective_from DESC NULLS LAST,
            ccr.created_at DESC
        LIMIT 1
    ) rate_match ON TRUE
    LEFT JOIN LATERAL (
        SELECT tma.pct, manager.name AS manager_name
        FROM team_manager_assignments tma
        LEFT JOIN users manager ON manager.id = tma.manager_id
        WHERE tma.team_id = team_match.team_id
          AND (tma.effective_from IS NULL OR tma.effective_from <= timezone('Europe/Sarajevo', t.occurred_at)::date)
          AND (tma.effective_until IS NULL OR tma.effective_until >= timezone('Europe/Sarajevo', t.occurred_at)::date)
        ORDER BY tma.effective_from DESC NULLS LAST, tma.created_at DESC
        LIMIT 1
    ) manager_match ON TRUE
    WHERE t.occurred_at IS NOT NULL
)
SELECT
    local_date AS date,
    occurred_at AS timestamp,
    creator_name AS creator,
    creator_id::text AS creator_id,
    creator_account_id::text AS creator_account_id,
    account_username AS account_username,
    resolved_chatter_name AS chatter,
    resolved_chatter_id::text AS chatter_id,
    upper(platform) AS platform,
    resolved_team AS team,
    NULL::text AS language,
    lower(type) AS transaction_type,
    gross_amount::float AS revenue,
    currency,
    CASE WHEN lower(type) = 'ppv' THEN gross_amount::float END AS unlock_amount,
    CASE WHEN lower(type) = 'subscription' THEN gross_amount::float END AS subscription_revenue,
    CASE WHEN lower(type) = 'tip' THEN gross_amount::float END AS tip_revenue,
    CASE WHEN lower(type) = 'message' THEN gross_amount::float END AS message_revenue,
    NULL::text AS shift_id,
    NULL::text AS shift_start,
    NULL::text AS shift_end,
    NULL::float AS shift_hours,
    NULL::float AS messages_sent,
    NULL::float AS active_hours,
    NULL::float AS inactive_minutes,
    id::text AS transaction_id,
    platform_transaction_id,
    status,
    net_amount::float AS net_amount,
    NULL::float AS md_net_amount,
    NULL::float AS partner_net_amount,
    NULL::float AS other_net_amount,
    NULL::float AS chatter_net_amount,
    flow_chatter_commission_pct,
    flow_manager_commission_pct,
    flow_manager_name,
    flow_commission_pool,
    fan_username,
    attribution_source,
    'postgres_transactions' AS source_type,
    id::text AS transaction_key
FROM enriched
`;

// Business dates are YYYY-MM-DD strings (Europe/Sarajevo).
export async function loadTransactions(pool: pg.Pool, start: string, end: string): Promise<Record<string, unknown>[]> {
    const result = await pool.query(TRANSACTIONS_SQL, [start, end]);
    return result.rows;
}
