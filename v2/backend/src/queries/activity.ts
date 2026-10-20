// Shift and inactivity rows for a business-date range (Europe/Sarajevo), in
// the same shape as revenue rows so pages can combine them. Ported from the
// Python app's SHIFT_SQL and INACTIVITY_SQL (app/postgres_source.py), keeping
// the columns pages use. $1 = start date, $2 = end date.
//
// The range is applied to the timestamp (clock_in / started_at) rather than to
// its local date, which is equivalent and lets Postgres use the indexes.

const RANGE_START = `($1::date)::timestamp AT TIME ZONE 'Europe/Sarajevo'`;
const RANGE_END = `($2::date + 1)::timestamp AT TIME ZONE 'Europe/Sarajevo'`;

// One row per worked shift. Hours of a shift still open count up to now(),
// as in the Python app. start_us/end_us: clock-in/out as epoch microseconds,
// exact in a JavaScript number (end_us is null while the shift is open).
export const SHIFT_ROWS_SQL = `
SELECT
    timezone('Europe/Sarajevo', s.clock_in)::date AS date,
    c.name AS creator,
    u.name AS chatter,
    upper(s.platform) AS platform,
    team_match.name AS team,
    'shift_summary'::text AS transaction_type,
    GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.clock_out, now()) - s.clock_in)) / 3600.0)::float AS shift_hours,
    s.id::text AS shift_id,
    s.creator_id::text AS creator_id,
    s.chatter_id::text AS chatter_id,
    (EXTRACT(EPOCH FROM s.clock_in) * 1000000)::bigint AS start_us,
    (EXTRACT(EPOCH FROM s.clock_out) * 1000000)::bigint AS end_us
FROM shifts s
LEFT JOIN creators c ON c.id = s.creator_id
LEFT JOIN users u ON u.id = s.chatter_id
LEFT JOIN LATERAL (
    SELECT team.name
    FROM chatter_team_assignments cta
    JOIN teams team ON team.id = cta.team_id
    WHERE cta.chatter_id = s.chatter_id
      AND (cta.effective_from IS NULL OR cta.effective_from <= timezone('Europe/Sarajevo', s.clock_in)::date)
      AND (cta.effective_until IS NULL OR cta.effective_until >= timezone('Europe/Sarajevo', s.clock_in)::date)
    ORDER BY cta.effective_from DESC NULLS LAST, cta.created_at DESC
    LIMIT 1
) team_match ON TRUE
WHERE s.clock_in >= ${RANGE_START}
  AND s.clock_in < ${RANGE_END}
`;

// One row per inactivity episode and assigned chatter (or one row without a
// chatter). Minutes and money are Flow's per-chatter split when present.
export const INACTIVITY_ROWS_SQL = `
SELECT
    timezone('Europe/Sarajevo', ie.started_at)::date AS date,
    c.name AS creator,
    u.name AS chatter,
    upper(ie.platform) AS platform,
    ie.team AS team,
    'inactivity'::text AS transaction_type,
    COALESCE(
        iec.minutes,
        COALESCE(ie.orange_minutes, 0) + COALESCE(ie.red_minutes, 0) + COALESCE(ie.dormant_minutes, 0)
    )::float AS inactive_minutes,
    COALESCE(iec.money_wasted_eur, COALESCE(ie.orange_money_wasted_eur, 0) + COALESCE(ie.red_money_wasted_eur, 0))::float AS inactivity_money_wasted,
    ie.peak_unread_chats::float AS peak_unread_chats,
    ie.id::text AS episode_id,
    ca.creator_id::text AS creator_id,
    iec.chatter_id::text AS chatter_id,
    (EXTRACT(EPOCH FROM ie.started_at) * 1000000)::bigint AS start_us,
    (EXTRACT(EPOCH FROM ie.ended_at) * 1000000)::bigint AS end_us
FROM inactivity_episodes ie
LEFT JOIN creator_accounts ca ON ca.id = ie.creator_account_id
LEFT JOIN creators c ON c.id = ca.creator_id
LEFT JOIN inactivity_episode_chatters iec ON iec.episode_id = ie.id
LEFT JOIN users u ON u.id = iec.chatter_id
WHERE ie.started_at >= ${RANGE_START}
  AND ie.started_at < ${RANGE_END}
`;
