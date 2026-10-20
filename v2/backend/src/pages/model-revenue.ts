import type pg from 'pg';
import {comparisonRange, maxDate, minDate, previousMonthSameDays, shortRangeLabel, type IsoDate} from '../lib/period.js';
import {agencyLabel, MODEL_PLATFORM_DEFAULTS, MODEL_REVENUE_AGENCIES} from '../lib/rosters.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import {
    caseInsensitiveSort, codePointSort, CORE_PLATFORMS, namedSql, PAGE_ROWS_CTE, platformLabel, platformLabelSql,
    platformOrder, revenueTrend, type TrendDay,
} from '../queries/page-rows.js';

// Model Revenue Overview (/c-hub/revenue). Reproduces the Python app's
// c_hub_revenue: one card per model with its revenue per platform.

export const MODEL_REVENUE_TYPES = ['message', 'tip', 'subscription', 'ppv'];

export interface ModelFilters {
    creator: string[];
    platform: string[];
    agency: string[];
    team: string[];
    transaction_type: string[];
}

export type ModelSort = 'revenue' | 'subscriptions' | 'model';

export interface ModelRevenueInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    filters: ModelFilters;
    sort: ModelSort;
    direction: 'asc' | 'desc';
    today: IsoDate;
    eurUsdRate?: number;
}

export interface ModelCard {
    model: string;
    total: number;
    subscriptionRevenue: number;
    currentSubs: number;
    // Agencies and tiers shown as badges; empty when unknown.
    agencies: string[];
    tiers: string[];
    platforms: {platform: string; revenue: number; share: number; currentSubs: number}[];
}

export interface ModelRevenue {
    period: {start: IsoDate; end: IsoDate; compare: string; compareStart: IsoDate; compareEnd: IsoDate};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    platformTotals: {platform: string; revenue: number; share: number}[];
    cards: ModelCard[];
    filterOptions: {creator: string[]; platform: string[]; agency: string[]; team: string[]; transaction_type: string[]};
    trend: {start: IsoDate; today: IsoDate; current: TrendDay[]; previous: TrendDay[]; previousLabel: string};
}

interface QueryResult {
    currentRows: number;
    previousRows: number;
    revenue: number;
    previousRevenue: number;
    // Every named creator in the load range, with the core platforms seen for it.
    roster: {model: string; platform: string | null}[] | null;
    // Revenue per model and platform after the model filters.
    revenue_rows: {model: string; platform: string; revenue: number; subscriptions: number}[] | null;
    teams: string[] | null;
}

// $1..$3: load range and rate; $4/$5 period; $6/$7 comparison; $8 revenue
// types; $9.. model filters.
function querySql(filters: ModelFilters, params: unknown[]): string {
    const conditions: string[] = [];
    if (filters.creator.length) {
        params.push(filters.creator);
        conditions.push(`btrim(COALESCE(creator, '')) = ANY($${params.length}::text[])`);
    }
    if (filters.platform.length) {
        params.push(filters.platform);
        conditions.push(`${platformLabelSql('platform')} = ANY($${params.length}::text[])`);
    }
    if (filters.team.length) {
        params.push(filters.team);
        conditions.push(`btrim(COALESCE(team, 'Unknown')) = ANY($${params.length}::text[])`);
    }
    if (filters.transaction_type.length) {
        params.push(filters.transaction_type);
        conditions.push(`lower(btrim(COALESCE(transaction_type, ''))) = ANY($${params.length}::text[])`);
    }
    const modelFilters = conditions.length ? conditions.join(' AND ') : 'TRUE';
    return `
WITH ${PAGE_ROWS_CTE},
period_revenue AS (
    SELECT * FROM page_rows
    WHERE date BETWEEN $4 AND $5 AND COALESCE(transaction_type, 'Unknown') = ANY($8::text[])
),
model_rows AS (
    SELECT btrim(creator) AS model, ${platformLabelSql('platform')} AS platform,
           COALESCE(revenue, 0) AS revenue,
           CASE WHEN lower(btrim(COALESCE(transaction_type, ''))) IN ('subscription', 'subscriptions') THEN COALESCE(revenue, 0) ELSE 0 END AS subscriptions
    FROM period_revenue
    WHERE ${modelFilters} AND ${namedSql('creator')}
)
SELECT json_build_object(
    'currentRows', (SELECT count(*) FROM page_rows WHERE date BETWEEN $4 AND $5),
    'previousRows', (SELECT count(*) FROM page_rows WHERE date BETWEEN $6 AND $7),
    'revenue', (SELECT COALESCE(sum(revenue), 0) FROM page_rows WHERE date BETWEEN $4 AND $5),
    'previousRevenue', (SELECT COALESCE(sum(revenue), 0) FROM page_rows WHERE date BETWEEN $6 AND $7),
    'roster', (SELECT json_agg(DISTINCT jsonb_build_object('model', btrim(creator), 'platform', ${platformLabelSql('platform')}))
               FROM page_rows WHERE ${namedSql('creator')}),
    'revenue_rows', (SELECT json_agg(r) FROM (
        SELECT model, platform, sum(revenue) AS revenue, sum(subscriptions) AS subscriptions
        FROM model_rows WHERE platform IN ('F2F', 'KNKY', 'OF') GROUP BY model, platform
    ) r),
    'teams', (SELECT array_agg(DISTINCT btrim(team)) FROM period_revenue WHERE btrim(COALESCE(team, '')) NOT IN ('', 'Unknown'))
) AS result`;
}

interface AccountRow {
    model: string;
    platform: string;
    agency: string;
    tier: string | null;
    current_subs: number | null;
}

// Agency, tier and current subscribers per model account. Only the columns
// needed here: creator_accounts also holds login credentials.
async function accountMetadata(pool: pg.Pool): Promise<Map<string, {currentSubs: number; agency: string; tier: string | null}>> {
    const result = await pool.query<AccountRow>(`
        SELECT btrim(COALESCE(c.name, ca.username, ca.creator_id::text)) AS model,
               upper(ca.platform) AS platform,
               COALESCE(c.agency, 'Unknown') AS agency,
               ca.tier,
               ca.current_subs
        FROM creator_accounts ca
        LEFT JOIN creators c ON c.id = ca.creator_id
        ORDER BY ca.id`);
    const byAccount = new Map<string, {currentSubs: number; agency: string; tier: string | null}>();
    for (const row of result.rows) {
        if (!row.model) continue;
        const key = `${row.model}|${platformLabel(row.platform)}`;
        const entry = byAccount.get(key) ?? {currentSubs: 0, agency: 'Unknown', tier: null};
        entry.currentSubs += Number(row.current_subs ?? 0) || 0;
        // First known agency and tier win (Python: model_platform_revenue).
        const agency = agencyLabel(row.agency);
        if (entry.agency === 'Unknown' && agency !== 'Unknown') entry.agency = agency;
        if (entry.tier === null && row.tier && row.tier.trim() && row.tier !== 'None') entry.tier = row.tier;
        byAccount.set(key, entry);
    }
    return byAccount;
}

function percentOf(part: number, whole: number): number {
    return whole <= 0 ? 0 : part / whole * 100;
}

export async function modelRevenue(pool: pg.Pool, input: ModelRevenueInput): Promise<ModelRevenue> {
    const {start, end, compare, filters, sort, direction, today} = input;
    const [compareStart, compareEnd] = comparisonRange(start, end, compare);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const params: unknown[] = [minDate(start, compareStart), maxDate(end, compareEnd), rate, start, end, compareStart, compareEnd, MODEL_REVENUE_TYPES];
    const sql = querySql(filters, params);

    const mtdStart = `${today.slice(0, 8)}01`;
    const [previousStart, previousEnd] = previousMonthSameDays(mtdStart, today);
    const [queryResult, metadata, currentTrend, previousTrend] = await Promise.all([
        pool.query<{result: QueryResult}>(sql, params),
        accountMetadata(pool),
        revenueTrend(pool, mtdStart, today, rate, MODEL_REVENUE_TYPES),
        revenueTrend(pool, previousStart, previousEnd, rate, MODEL_REVENUE_TYPES),
    ]);
    const q = queryResult.rows[0].result;

    // Roster: the fixed models plus every creator in the loaded data, each with
    // its fixed platforms plus the core platforms seen in the data.
    const platformsByModel = new Map<string, string[]>(Object.entries(MODEL_PLATFORM_DEFAULTS).map(([m, p]) => [m, [...p]]));
    const addPlatform = (model: string, platform: string) => {
        const list = platformsByModel.get(model) ?? [];
        if (!list.includes(platform)) list.push(platform);
        platformsByModel.set(model, list);
    };
    const names = new Set(Object.keys(MODEL_PLATFORM_DEFAULTS));
    for (const {model, platform} of q.roster ?? []) {
        names.add(model);
        if (platform && (CORE_PLATFORMS as readonly string[]).includes(platform)) addPlatform(model, platform);
    }
    const revenueRows = q.revenue_rows ?? [];
    for (const row of revenueRows) {
        names.add(row.model);
        addPlatform(row.model, row.platform);
    }
    const roster = caseInsensitiveSort([...names]);

    const revenueByKey = new Map(revenueRows.map(r => [`${r.model}|${r.platform}`, r]));
    let rows = roster.flatMap(model => (platformsByModel.get(model) ?? ['F2F'])
        .slice().sort((a, b) => platformOrder(a) - platformOrder(b))
        .map(platform => {
            const revenue = revenueByKey.get(`${model}|${platform}`);
            const meta = metadata.get(`${model}|${platform}`);
            return {
                model,
                platform,
                revenue: Number(revenue?.revenue ?? 0),
                subscriptions: Number(revenue?.subscriptions ?? 0),
                currentSubs: meta?.currentSubs ?? 0,
                agency: meta?.agency ?? 'Unknown',
                tier: meta?.tier ?? null,
            };
        }));

    // Card filters (Python: filter_model_card_rows).
    if (filters.creator.length) rows = rows.filter(r => filters.creator.includes(r.model));
    if (filters.platform.length) rows = rows.filter(r => filters.platform.includes(r.platform));
    if (filters.agency.length) rows = rows.filter(r => filters.agency.includes(r.agency));

    // Platform totals strip.
    const platformSum = (platform: string) => rows.filter(r => r.platform === platform).reduce((s, r) => s + r.revenue, 0);
    const grandTotal = CORE_PLATFORMS.reduce((s, p) => s + platformSum(p), 0);
    const platformTotals = CORE_PLATFORMS.map(platform => ({platform, revenue: platformSum(platform), share: percentOf(platformSum(platform), grandTotal)}));

    // One card per model (Python: c_revenue_breakdown_cards).
    const models = [...new Set(rows.map(r => r.model))];
    let cards: ModelCard[] = models.map(model => {
        const own = rows.filter(r => r.model === model);
        const total = own.reduce((s, r) => s + r.revenue, 0);
        const ordered = [...own].sort((a, b) => platformOrder(a.platform) - platformOrder(b.platform) || a.platform.localeCompare(b.platform));
        return {
            model,
            total,
            subscriptionRevenue: own.reduce((s, r) => s + r.subscriptions, 0),
            currentSubs: own.reduce((s, r) => s + r.currentSubs, 0),
            agencies: codePointSort([...new Set(own.map(r => r.agency).filter(a => a !== 'Unknown'))]),
            tiers: [...new Set(ordered.map(r => r.tier).filter((t): t is string => Boolean(t)))],
            platforms: [...own]
                .sort((a, b) => platformOrder(a.platform) - platformOrder(b.platform) || b.revenue - a.revenue)
                .map(r => ({platform: r.platform, revenue: r.revenue, share: percentOf(r.revenue, total), currentSubs: r.currentSubs})),
        };
    });
    const factor = direction === 'asc' ? 1 : -1;
    const byName = (a: ModelCard, b: ModelCard) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
    if (sort === 'model') {
        cards = [...cards].sort((a, b) => factor * (a.model.toLowerCase() < b.model.toLowerCase() ? -1 : a.model.toLowerCase() > b.model.toLowerCase() ? 1 : 0));
    } else {
        const key = sort === 'subscriptions' ? 'subscriptionRevenue' : 'total';
        cards = [...cards].sort((a, b) => factor * (a[key] - b[key]) || byName(a, b));
    }

    const agencies = caseInsensitiveSort([...new Set([
        ...MODEL_REVENUE_AGENCIES,
        ...[...metadata.values()].map(m => m.agency).filter(a => a !== 'Unknown'),
    ])]);

    return {
        period: {start, end, compare, compareStart, compareEnd},
        eurUsdRate: rate,
        comparison: {
            currentRevenue: q.currentRows ? q.revenue : null,
            previousRevenue: q.previousRows ? q.previousRevenue : null,
        },
        platformTotals,
        cards,
        filterOptions: {
            creator: roster,
            platform: [...CORE_PLATFORMS],
            agency: agencies,
            team: caseInsensitiveSort(q.teams ?? []),
            transaction_type: MODEL_REVENUE_TYPES,
        },
        trend: {
            start: mtdStart,
            today,
            current: currentTrend,
            previous: previousTrend,
            previousLabel: shortRangeLabel(previousStart, previousEnd),
        },
    };
}
