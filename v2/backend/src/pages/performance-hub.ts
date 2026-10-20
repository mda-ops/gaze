import type pg from 'pg';
import {
    buildHub1, buildHub2, officialTiers, rosterFromGrades, transitionWatch, weekWindows,
    type GradeInput, type Hub2Filters, type HubRevenue, type HubScheduled, type HubShift, type OfficialTierInput,
} from '../lib/performance-hub.js';
import type {IsoDate} from '../lib/period.js';
import {SHIFT_ROWS_SQL} from '../queries/activity.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import {TRANSACTIONS_SQL} from '../queries/transactions.js';

// Performance Hub (/c-hub/performance) and Performance Hub 2
// (/c-hub/performance-2): four reporting weeks ending with the selected end
// date. HR scores come from Flow's chatter grades. (The Python app can also add
// Notion HR status, team and tier; not connected in v2 yet.)

const PY_TIMESTAMP = (column: string) => `to_char(${column} AT TIME ZONE 'UTC',
    CASE WHEN extract(microseconds FROM ${column})::bigint % 1000000 = 0 THEN 'YYYY-MM-DD HH24:MI:SS' ELSE 'YYYY-MM-DD HH24:MI:SS.US' END) || '+00:00'`;

// Flow's latest grade per chatter (Python: CHATTER_GRADES_SQL).
const GRADES_SQL = `
WITH ranked AS (
    SELECT cg.*, u.name AS chatter_name, u.status AS chatter_status,
           row_number() OVER (PARTITION BY cg.chatter_id ORDER BY cg.graded_at DESC NULLS LAST, cg.id DESC) AS rn
    FROM chatter_grades cg
    LEFT JOIN users u ON u.id = cg.chatter_id
)
SELECT chatter_name AS name, chatter_status AS status, NULL::text AS team,
       chat_quality_score::float AS chat_quality, activity_score::float AS activity, notes,
       CASE WHEN graded_at IS NULL THEN NULL ELSE ${PY_TIMESTAMP('graded_at')} END AS latest_grade_date
FROM ranked WHERE rn = 1 AND chatter_name IS NOT NULL`;

interface HubInputs {
    grades: GradeInput[];
    shifts: HubShift[];
    revenue: HubRevenue[];
    scheduled: HubScheduled[];
    tiers: OfficialTierInput[];
}

async function loadInputs(pool: pg.Pool, start: IsoDate, end: IsoDate, rate: number): Promise<HubInputs> {
    const [grades, shifts, revenue, scheduled, tiers] = await Promise.all([
        pool.query<{name: string; status: string | null; team: string | null; chat_quality: number | null; activity: number | null; notes: string | null; latest_grade_date: string | null}>(GRADES_SQL),
        pool.query<{date: string; chatter: string | null; start_us: string; end_us: string | null; shift_hours: number}>(
            `SELECT date::text AS date, chatter, start_us, end_us, shift_hours FROM (${SHIFT_ROWS_SQL}) s`, [start, end]),
        pool.query<{date: string; chatter: string | null; creator: string | null; creator_id: string | null; revenue: number}>(`
            WITH tx AS (${TRANSACTIONS_SQL})
            SELECT date::text AS date, chatter, creator, creator_id,
                   sum(CASE currency WHEN 'USD' THEN revenue / $3 ELSE revenue END) AS revenue
            FROM tx WHERE revenue IS NOT NULL
            GROUP BY 1, 2, 3, 4`, [start, end, rate]),
        // Planned shifts, one per chatter and interval (Python: load_postgres_scheduled_shifts).
        pool.query<{date: string; chatter: string | null; hours: number}>(`
            SELECT DISTINCT ON (ss.chatter_id, ss.starts_at, ss.ends_at)
                   timezone('Europe/Sarajevo', ss.starts_at)::date::text AS date, u.name AS chatter,
                   GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(ss.ends_at, ss.starts_at) - ss.starts_at)) / 3600.0)::float AS hours
            FROM scheduled_shifts ss
            LEFT JOIN users u ON u.id = ss.chatter_id
            WHERE ss.starts_at IS NOT NULL AND ss.ends_at IS NOT NULL
              AND ss.starts_at >= ($1::date)::timestamp AT TIME ZONE 'Europe/Sarajevo'
              AND ss.starts_at < ($2::date + 1)::timestamp AT TIME ZONE 'Europe/Sarajevo'
            ORDER BY ss.chatter_id, ss.starts_at, ss.ends_at`, [start, end]),
        // Model tiers from Flow's creator accounts (only the columns needed).
        pool.query<{creator: string | null; creator_id: string | null; tier: string | null}>(`
            SELECT COALESCE(c.name, ca.username) AS creator, ca.creator_id::text AS creator_id, ca.tier::text AS tier
            FROM creator_accounts ca LEFT JOIN creators c ON c.id = ca.creator_id
            WHERE COALESCE(ca.tier::text, '') <> ''`),
    ]);
    return {
        grades: grades.rows.map(g => ({
            name: g.name, status: g.status, team: g.team, chatQuality: g.chat_quality, activity: g.activity, notes: g.notes,
            latestGradeDate: g.latest_grade_date,
        })),
        shifts: shifts.rows.filter(s => s.chatter !== null).map(s => ({
            date: s.date, chatter: s.chatter!, startUs: Number(s.start_us), endUs: s.end_us === null ? null : Number(s.end_us), shiftHours: Number(s.shift_hours) || 0,
        })),
        revenue: revenue.rows.map(r => ({date: r.date, chatter: r.chatter, creator: r.creator, creatorId: r.creator_id, revenue: Number(r.revenue)})),
        scheduled: scheduled.rows.map(s => ({date: s.date, chatter: s.chatter, hours: Number(s.hours)})),
        tiers: tiers.rows.map(t => ({creator: t.creator, creatorId: t.creator_id, tier: t.tier})),
    };
}

export interface HubInput {
    end: IsoDate;
    weekStart: string;
    eurUsdRate?: number;
}

export async function performanceHub(pool: pg.Pool, input: HubInput) {
    const windows = weekWindows(input.end, input.weekStart);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const data = await loadInputs(pool, windows[0].start, input.end, rate);
    const roster = rosterFromGrades(data.grades);
    const hub = buildHub1({end: input.end, weekStart: input.weekStart, roster, shifts: data.shifts, revenue: data.revenue, tiers: officialTiers(data.tiers)});
    return {
        ...hub,
        transition: transitionWatch(roster),
        hrSource: roster.length ? 'RevenueCatcher Chatter Grades' : 'No HR source connected',
        hrRows: data.grades.length,
    };
}

export async function performanceHub2(pool: pg.Pool, input: HubInput & {filters?: Hub2Filters}) {
    const windows = weekWindows(input.end, input.weekStart);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const data = await loadInputs(pool, windows[0].start, input.end, rate);
    const roster = rosterFromGrades(data.grades);
    const common = {end: input.end, weekStart: input.weekStart, roster, shifts: data.shifts, revenue: data.revenue, scheduled: data.scheduled, tiers: officialTiers(data.tiers)};
    const unfiltered = buildHub2(common);
    const filters = input.filters;
    const hub = filters && (filters.team || filters.tier || filters.score) ? buildHub2({...common, filters}) : unfiltered;
    const teams = [...new Set(unfiltered.current.map(c => c.team).filter(t => t && t !== 'Unknown'))].sort();
    const tierValues = new Set(unfiltered.current.map(c => c.tier));
    return {
        ...hub,
        transition: transitionWatch(roster),
        filterOptions: {teams, tiers: ['A', 'B', 'C', 'Pending score'].filter(t => tierValues.has(t))},
    };
}
