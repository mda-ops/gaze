import type pg from 'pg';
import {comparisonRange, maxDate, minDate, type IsoDate} from '../lib/period.js';
import {chatterDefaultPlatforms} from '../lib/rosters.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import {
    caseInsensitiveSort, CORE_PLATFORMS, namedSql, PAGE_ROWS_CTE, platformLabelSql, platformOrder,
} from '../queries/page-rows.js';

// Chatter Revenue Overview (/c-hub/chatter-revenue). Reproduces the Python
// app's c_hub_chatter_revenue: tips and messages per chatter and platform.

export const CHATTER_REVENUE_TYPES = ['tip', 'message'];

export interface ChatterFilters {
    chatter: string[];
    platform: string[];
    team: string[];
    creator: string[];
    transaction_type: string[];
}

export interface ChatterRevenueInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    filters: ChatterFilters;
    sort: 'revenue' | 'chatter';
    direction: 'asc' | 'desc';
    eurUsdRate?: number;
}

export interface ChatterCard {
    chatter: string;
    total: number;
    // Revenue per worked shift hour; null without shift hours.
    revenuePerHour: number | null;
    platforms: {platform: string; revenue: number; share: number}[];
}

export interface ChatterRevenue {
    period: {start: IsoDate; end: IsoDate; compare: string; compareStart: IsoDate; compareEnd: IsoDate};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    metrics: {
        totalRevenue: number;
        revenueChangePct: number | null;
        activeChatters: number;
        avgPerChatter: number | null;
        revenuePerHour: number | null;
        totalHours: number;
    };
    platformTotals: {platform: string; revenue: number; share: number}[];
    cards: ChatterCard[];
    filterOptions: {chatter: string[]; platform: string[]; team: string[]; creator: string[]; transaction_type: string[]};
}

interface QueryResult {
    currentRows: number;
    previousRows: number;
    pageRevenue: number;
    pagePreviousRevenue: number;
    revenue: number;
    previousRevenue: number;
    activeChatters: number;
    workedShiftCount: number;
    workedShiftHours: number;
    allShiftHours: number;
    // Named chatters' revenue per platform label (all platforms).
    chatterRevenue: {chatter: string; platform: string; revenue: number; nonZero: boolean}[] | null;
    // How often each named chatter appears with each named team.
    chatterTeams: {chatter: string; team: string; count: number}[] | null;
    chatterHours: {chatter: string; hours: number}[] | null;
    options: {chatter: string[] | null; team: string[] | null; creator: string[] | null};
}

// Revenue-row filters of the chatter card form (Python: apply_chatter_revenue_filters).
function chatterFilterSql(filters: ChatterFilters, params: unknown[]): string {
    const conditions: string[] = [];
    for (const field of ['chatter', 'team', 'creator'] as const) {
        if (!filters[field].length) continue;
        params.push(filters[field]);
        conditions.push(`btrim(COALESCE(${field}, 'Unknown')) = ANY($${params.length}::text[])`);
    }
    if (filters.transaction_type.length) {
        params.push(filters.transaction_type.map(t => t.toLowerCase()));
        conditions.push(`lower(btrim(COALESCE(transaction_type, 'Unknown'))) = ANY($${params.length}::text[])`);
    }
    if (filters.platform.length) {
        params.push(filters.platform);
        conditions.push(`${platformLabelSql('platform')} = ANY($${params.length}::text[])`);
    }
    return conditions.length ? conditions.join(' AND ') : 'TRUE';
}

// Shift filters for the per-chatter hours (Python: scheduled_shift_rows with
// the card filters): raw values, missing ones count as "Unknown".
function shiftFilterSql(filters: ChatterFilters, params: unknown[]): string {
    const conditions: string[] = [];
    for (const field of ['platform', 'team', 'creator', 'chatter'] as const) {
        if (!filters[field].length) continue;
        params.push(filters[field]);
        conditions.push(`COALESCE(${field}, 'Unknown') = ANY($${params.length}::text[])`);
    }
    return conditions.length ? conditions.join(' AND ') : 'TRUE';
}

function querySql(filters: ChatterFilters, params: unknown[]): string {
    const revenueFilters = chatterFilterSql(filters, params);
    const shiftFilters = shiftFilterSql(filters, params);
    const worked = (extra: string) => `
        SELECT shift_id, max(btrim(chatter)) AS chatter, max(chatter) AS raw_chatter, max(shift_hours) AS hours
        FROM page_rows
        WHERE date BETWEEN $4 AND $5 AND transaction_type = 'shift_summary' AND ${extra}
          AND ${namedSql('chatter')} AND COALESCE(shift_hours, 0) > 0
        GROUP BY shift_id`;
    return `
WITH ${PAGE_ROWS_CTE},
all_current AS (SELECT * FROM page_rows WHERE date BETWEEN $4 AND $5 AND COALESCE(transaction_type, 'Unknown') = ANY($8::text[])),
all_previous AS (SELECT * FROM page_rows WHERE date BETWEEN $6 AND $7 AND COALESCE(transaction_type, 'Unknown') = ANY($8::text[])),
current_revenue AS (SELECT * FROM all_current WHERE ${revenueFilters}),
previous_revenue AS (SELECT * FROM all_previous WHERE ${revenueFilters}),
worked_shifts AS (${worked('TRUE')}),
filtered_shifts AS (${worked(shiftFilters)})
SELECT json_build_object(
    'currentRows', (SELECT count(*) FROM page_rows WHERE date BETWEEN $4 AND $5),
    'previousRows', (SELECT count(*) FROM page_rows WHERE date BETWEEN $6 AND $7),
    'pageRevenue', (SELECT COALESCE(sum(revenue), 0) FROM page_rows WHERE date BETWEEN $4 AND $5),
    'pagePreviousRevenue', (SELECT COALESCE(sum(revenue), 0) FROM page_rows WHERE date BETWEEN $6 AND $7),
    'revenue', (SELECT COALESCE(sum(revenue), 0) FROM current_revenue),
    'previousRevenue', (SELECT COALESCE(sum(revenue), 0) FROM previous_revenue),
    'activeChatters', (SELECT count(DISTINCT NULLIF(chatter, '')) FROM current_revenue),
    'workedShiftCount', (SELECT count(*) FROM worked_shifts),
    'workedShiftHours', (SELECT COALESCE(sum(hours), 0) FROM worked_shifts),
    'allShiftHours', (SELECT COALESCE(sum(shift_hours), 0) FROM current_revenue),
    'chatterRevenue', (SELECT json_agg(r) FROM (
        SELECT btrim(chatter) AS chatter, ${platformLabelSql('platform')} AS platform,
               sum(COALESCE(revenue, 0)) AS revenue, bool_or(COALESCE(revenue, 0) <> 0) AS "nonZero"
        FROM current_revenue WHERE ${namedSql('chatter')}
        GROUP BY 1, 2
    ) r),
    'chatterTeams', (SELECT json_agg(t) FROM (
        SELECT btrim(chatter) AS chatter, btrim(team) AS team, count(*) AS count
        FROM current_revenue WHERE ${namedSql('chatter')} AND ${namedSql('team')}
        GROUP BY 1, 2
    ) t),
    'chatterHours', (SELECT json_agg(h) FROM (
        SELECT raw_chatter AS chatter, sum(hours) AS hours FROM filtered_shifts GROUP BY raw_chatter
    ) h),
    'options', json_build_object(
        'chatter', (SELECT array_agg(DISTINCT btrim(chatter)) FROM all_current WHERE btrim(COALESCE(chatter, '')) NOT IN ('', 'Unknown')),
        'team', (SELECT array_agg(DISTINCT btrim(team)) FROM all_current WHERE btrim(COALESCE(team, '')) NOT IN ('', 'Unknown')),
        'creator', (SELECT array_agg(DISTINCT btrim(creator)) FROM all_current WHERE btrim(COALESCE(creator, '')) NOT IN ('', 'Unknown'))
    )
) AS result`;
}

function percentOf(part: number, whole: number): number {
    return whole <= 0 ? 0 : part / whole * 100;
}

// Each chatter's most frequent team; ties go to the alphabetically first team
// (Python: chatter_team_lookup).
function mainTeams(rows: QueryResult['chatterTeams']): Map<string, string> {
    const best = new Map<string, {team: string; count: number}>();
    for (const {chatter, team, count} of rows ?? []) {
        const current = best.get(chatter);
        if (!current || count > current.count || (count === current.count && team < current.team)) best.set(chatter, {team, count: Number(count)});
    }
    return new Map([...best].map(([chatter, {team}]) => [chatter, team]));
}

export async function chatterRevenue(pool: pg.Pool, input: ChatterRevenueInput): Promise<ChatterRevenue> {
    const {start, end, compare, filters, sort, direction} = input;
    const [compareStart, compareEnd] = comparisonRange(start, end, compare);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const params: unknown[] = [minDate(start, compareStart), maxDate(end, compareEnd), rate, start, end, compareStart, compareEnd, CHATTER_REVENUE_TYPES];
    const q = (await pool.query<{result: QueryResult}>(querySql(filters, params), params)).rows[0].result;

    // KPI cards (Python: executive_metrics, then apply_scheduled_hours).
    const totalHours = q.workedShiftCount > 0 ? q.workedShiftHours : q.allShiftHours;
    const metrics = {
        totalRevenue: q.revenue,
        revenueChangePct: q.previousRevenue ? (q.revenue - q.previousRevenue) / q.previousRevenue * 100 : null,
        activeChatters: q.activeChatters,
        avgPerChatter: q.activeChatters ? q.revenue / q.activeChatters : null,
        revenuePerHour: totalHours ? q.revenue / totalHours : null,
        totalHours,
    };

    // Card grid: every chatter with revenue rows, on their default platforms
    // plus any core platform where they had non-zero revenue.
    const revenueRows = q.chatterRevenue ?? [];
    const teams = mainTeams(q.chatterTeams);
    const roster = caseInsensitiveSort([...new Set(revenueRows.map(r => r.chatter))]);
    const coreRows = revenueRows.filter(r => (CORE_PLATFORMS as readonly string[]).includes(r.platform));
    const platformsByChatter = new Map(roster.map(chatter => [chatter, chatterDefaultPlatforms(teams.get(chatter), chatter)]));
    for (const row of coreRows) {
        const list = platformsByChatter.get(row.chatter)!;
        if (row.nonZero && !list.includes(row.platform)) list.push(row.platform);
    }
    const revenueByKey = new Map(coreRows.map(r => [`${r.chatter}|${r.platform}`, Number(r.revenue)]));
    const rows = roster.flatMap(chatter => platformsByChatter.get(chatter)!
        .slice().sort((a, b) => platformOrder(a) - platformOrder(b))
        .map(platform => ({chatter, platform, revenue: revenueByKey.get(`${chatter}|${platform}`) ?? 0})));

    const platformSum = (platform: string) => rows.filter(r => r.platform === platform).reduce((s, r) => s + r.revenue, 0);
    const grandTotal = CORE_PLATFORMS.reduce((s, p) => s + platformSum(p), 0);
    const hours = new Map((q.chatterHours ?? []).map(h => [h.chatter, Number(h.hours)]));

    let cards: ChatterCard[] = roster.map(chatter => {
        const own = rows.filter(r => r.chatter === chatter);
        const total = own.reduce((s, r) => s + r.revenue, 0);
        const chatterHours = hours.get(chatter) ?? 0;
        return {
            chatter,
            total,
            revenuePerHour: chatterHours > 0 ? total / chatterHours : null,
            platforms: [...own]
                .sort((a, b) => platformOrder(a.platform) - platformOrder(b.platform) || b.revenue - a.revenue)
                .map(r => ({platform: r.platform, revenue: r.revenue, share: percentOf(r.revenue, total)})),
        };
    });
    const factor = direction === 'asc' ? 1 : -1;
    if (sort === 'chatter') {
        cards = [...cards].sort((a, b) => factor * (a.chatter.toLowerCase() < b.chatter.toLowerCase() ? -1 : a.chatter.toLowerCase() > b.chatter.toLowerCase() ? 1 : 0));
    } else {
        cards = [...cards].sort((a, b) => factor * (a.total - b.total) || (a.chatter < b.chatter ? -1 : a.chatter > b.chatter ? 1 : 0));
    }

    return {
        period: {start, end, compare, compareStart, compareEnd},
        eurUsdRate: rate,
        comparison: {
            currentRevenue: q.currentRows ? q.pageRevenue : null,
            previousRevenue: q.previousRows ? q.pagePreviousRevenue : null,
        },
        metrics,
        platformTotals: CORE_PLATFORMS.map(platform => ({platform, revenue: platformSum(platform), share: percentOf(platformSum(platform), grandTotal)})),
        cards,
        filterOptions: {
            chatter: caseInsensitiveSort(q.options.chatter ?? []),
            platform: [...CORE_PLATFORMS],
            team: caseInsensitiveSort(q.options.team ?? []),
            creator: caseInsensitiveSort(q.options.creator ?? []),
            transaction_type: CHATTER_REVENUE_TYPES,
        },
    };
}
