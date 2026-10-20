import type pg from 'pg';
import type {IsoDate} from '../lib/period.js';

// Flow configuration used by the commission calculations.

// Current target per model account (Python: load_postgres_account_targets).
// The Python app discovers target tables dynamically; in Flow's schema the
// only one it can use is account_targets: the latest target_revenue per
// creator and platform by effective_from (effective_until is not checked).
// OF/KNKY targets are in USD.
export async function loadAccountTargets(pool: pg.Pool): Promise<{creatorId: string; platform: string; target: number}[]> {
    const result = await pool.query<{creator_id: string; platform: string; current_target: number; account: string | null}>(`
        WITH ranked AS (
            SELECT t.*, row_number() OVER (
                PARTITION BY COALESCE(t.creator_id::text, ''), COALESCE(t.platform::text, '')
                ORDER BY t.effective_from DESC NULLS LAST
            ) AS rn
            FROM account_targets t
        )
        SELECT c.name AS account, c.id::text AS creator_id, upper(COALESCE(t.platform, '')) AS platform,
               t.target_revenue::float AS current_target
        FROM ranked t
        LEFT JOIN creators c ON c.id = t.creator_id
        WHERE rn = 1 AND COALESCE(t.target_revenue, 0) > 0`);
    // Python keeps the first row per (account name, platform), case-insensitive.
    const seen = new Set<string>();
    const targets: {creatorId: string; platform: string; target: number}[] = [];
    for (const row of result.rows) {
        const key = `${(row.account ?? '').trim().toLowerCase()}|${row.platform.trim().toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({creatorId: row.creator_id ?? '', platform: row.platform, target: Number(row.current_target)});
    }
    return targets;
}

export interface TeamBonusRule {
    team: string;
    type: string | null;
    // per_account_tiered tiers carry thresholdMultiplier, flat_day_threshold tiers thresholdUsd.
    config: {tiers?: {rate?: number; thresholdMultiplier?: number; thresholdUsd?: number}[]} | null;
}

// Flow's team bonus configuration (Python: load_postgres_flow_team_rules).
export async function loadTeamBonusRules(pool: pg.Pool): Promise<TeamBonusRule[]> {
    const result = await pool.query<{team: string; bonus_rule_type: string | null; bonus_rule_config: unknown}>(
        'SELECT name AS team, bonus_rule_type, bonus_rule_config FROM teams');
    return result.rows.map(r => {
        let config = r.bonus_rule_config;
        if (typeof config === 'string') {
            try {
                config = JSON.parse(config);
            } catch {
                config = {};
            }
        }
        return {team: r.team, type: r.bonus_rule_type, config: (config ?? {}) as TeamBonusRule['config']};
    });
}

// Planned schedule hours per team and chatter (Python: load_postgres_scheduled_shifts,
// duplicates of the same chatter and interval counted once).
export async function loadScheduledHours(pool: pg.Pool, start: IsoDate, end: IsoDate): Promise<{team: string; chatter: string; hours: number}[]> {
    const result = await pool.query<{team: string | null; chatter: string | null; hours: number}>(`
        WITH scheduled AS (
            SELECT DISTINCT ON (ss.chatter_id, ss.starts_at, ss.ends_at)
                   u.name AS chatter, team_match.name AS team,
                   GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(ss.ends_at, ss.starts_at) - ss.starts_at)) / 3600.0)::float AS hours
            FROM scheduled_shifts ss
            LEFT JOIN users u ON u.id = ss.chatter_id
            LEFT JOIN LATERAL (
                SELECT t.name
                FROM chatter_team_assignments cta
                JOIN teams t ON t.id = cta.team_id
                WHERE cta.chatter_id = ss.chatter_id
                  AND (cta.effective_from IS NULL OR cta.effective_from <= timezone('Europe/Sarajevo', ss.starts_at)::date)
                  AND (cta.effective_until IS NULL OR cta.effective_until >= timezone('Europe/Sarajevo', ss.starts_at)::date)
                ORDER BY cta.effective_from DESC NULLS LAST, cta.created_at DESC
                LIMIT 1
            ) team_match ON TRUE
            WHERE ss.starts_at IS NOT NULL AND ss.ends_at IS NOT NULL
              AND ss.starts_at >= ($1::date)::timestamp AT TIME ZONE 'Europe/Sarajevo'
              AND ss.starts_at < ($2::date + 1)::timestamp AT TIME ZONE 'Europe/Sarajevo'
            ORDER BY ss.chatter_id, ss.starts_at, ss.ends_at
        )
        SELECT btrim(COALESCE(team, '')) AS team, btrim(COALESCE(chatter, '')) AS chatter, sum(hours) AS hours
        FROM scheduled GROUP BY 1, 2`, [start, end]);
    return result.rows.map(r => ({team: r.team ?? '', chatter: r.chatter ?? '', hours: Number(r.hours)}));
}
