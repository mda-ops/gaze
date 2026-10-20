-- Frozen copy of TRANSACTION_SQL from app/postgres_source.py (Python app),
-- plus the date filter it appends. Used only by the parity test.
-- One deliberate change: the shift_match ORDER BY gains an `s.id` tiebreak.
-- Without it, two shifts with the same clock_in (seen on 2026-07-30) make the
-- chosen chatter arbitrary and this comparison flaky.
WITH enriched AS (
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
        t.attribution_source,
        NULL::numeric AS md_net_amount,
        NULL::numeric AS partner_net_amount,
        NULL::numeric AS other_net_amount,
        NULL::numeric AS chatter_net_amount
    FROM transactions t
    LEFT JOIN creators c ON c.id = t.creator_id
    LEFT JOIN creator_accounts ca ON ca.id = t.creator_account_id
    LEFT JOIN users u ON u.id = t.chatter_id
    LEFT JOIN LATERAL (
        SELECT s.chatter_id
        FROM shifts s
        WHERE s.creator_id = t.creator_id
          AND lower(s.platform) = lower(t.platform)
          AND t.occurred_at >= s.clock_in
          AND t.occurred_at <= COALESCE(s.clock_out, now())
        ORDER BY s.clock_in DESC, s.id
        LIMIT 1
    ) shift_match ON TRUE
    LEFT JOIN users shift_user ON shift_user.id = shift_match.chatter_id
    -- Team membership is effective-dated in Flow.  Resolve it on the date of
    -- each transaction so historical payouts remain in their actual team.
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
    -- Flow stores the chatter rate per chatter / creator / platform.  Prefer
    -- a rate active on the transaction date; a preceding recorded rate is a
    -- safer historical fallback than Gaze's generic default percentage.
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
      AND COALESCE(t.gross_amount, 0) <> 0
      -- Revenue Catcher's manager totals exclude records still marked "done".
      -- Keeping them here made Gaze count an extra revenue stream.
      AND lower(COALESCE(t.status, '')) <> 'done'
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
    md_net_amount::float AS md_net_amount,
    partner_net_amount::float AS partner_net_amount,
    other_net_amount::float AS other_net_amount,
    chatter_net_amount::float AS chatter_net_amount,
    flow_chatter_commission_pct,
    flow_manager_commission_pct,
    flow_manager_name,
    flow_commission_pool,
    fan_username,
    attribution_source,
    'postgres_transactions' AS source_type,
    id::text AS transaction_key
FROM enriched
WHERE local_date BETWEEN $1::date AND $2::date
