import type pg from 'pg';
import {filterSql, type Filters} from '../lib/filters.js';
import {
    creatorKey, matchEpisodesToShifts, priceEpisodes, tierMaps,
    type CreatorTier, type EpisodeInput, type PricedEpisode, type RevenueInput, type ShiftInput,
} from '../lib/inactivity-cost.js';
import {comparisonRange, maxDate, minDate, type IsoDate} from '../lib/period.js';
import {INACTIVITY_ROWS_SQL, SHIFT_ROWS_SQL} from '../queries/activity.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import {FILTER_OPTIONS_SQL, filterOptions, PAGE_ROWS_CTE, type FilterOptions, type RawFilterOptions} from '../queries/page-rows.js';

// Inactivity (/inactivity and /c-hub/inactivity). Reproduces the Python app's
// inactivity handler: inactivity overlapping worked shifts, priced with the
// model's revenue per hour (lib/inactivity-cost.ts).

export interface InactivityInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    // Transaction type does not apply on this page.
    filters: Filters;
    eurUsdRate?: number;
}

export interface InactivitySummary {
    events: number;
    peakUnread: number;
    totalHours: number;
    moneyWasted: number;
    worstChatter: string | null;
    worstMoney: number;
}

export interface ChatterInactivity {
    chatter: string;
    events: number;
    creators: number;
    platforms: string;
    peakUnread: number;
    totalHours: number;
    maxHours: number;
    moneyWasted: number;
    avgCostPerHour: number;
}

export interface TierInactivity {
    creatorTier: string;
    events: number;
    models: number;
    scheduledHours: number;
    moneyWasted: number;
    shiftHours: number;
    inactivityPct: number;
    avgCostPerHour: number;
}

export interface Inactivity {
    period: {start: IsoDate; end: IsoDate; compare: string; compareStart: IsoDate; compareEnd: IsoDate};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    // Every priced episode of the period (for drill-downs and checks).
    currentEpisodes: PricedEpisode[];
    current: InactivitySummary;
    previous: InactivitySummary;
    tiers: TierInactivity[];
    chatters: ChatterInactivity[];
    insights: {topMoney: ChatterInactivity; topUnread: ChatterInactivity; topHours: ChatterInactivity} | null;
    filterOptions: FilterOptions;
}

const FILTER_FIELDS = ['platform', 'team', 'creator', 'chatter'] as const;
// Revenue rows that make up model revenue (Python: model_revenue_source).
const MODEL_REVENUE_TYPES = ['tip', 'tips', 'message', 'messages', 'subscription', 'subscriptions', 'ppv'];

interface ShiftRow {
    date: string;
    creator: string | null;
    chatter: string | null;
    creator_id: string | null;
    chatter_id: string | null;
    start_us: string;
    end_us: string | null;
    shift_hours: number;
}

interface EpisodeRow {
    date: string;
    episode_id: string;
    creator: string | null;
    chatter: string | null;
    creator_id: string | null;
    chatter_id: string | null;
    platform: string | null;
    team: string | null;
    start_us: string;
    end_us: string | null;
    inactive_minutes: number | null;
    peak_unread_chats: number | null;
}

interface PageQueryResult {
    currentRows: number;
    previousRows: number;
    revenue: number;
    previousRevenue: number;
    options: RawFilterOptions;
    // Tips + messages per model and Sarajevo hour, flagged by period.
    modelRevenue: {creator_id: string | null; creator_key: string; local_hour: number; current: boolean; previous: boolean; cost: number}[] | null;
    // Whether each period has any named model revenue (Python: has_model_revenue_rows).
    hasModelRevenueCurrent: boolean;
    hasModelRevenuePrevious: boolean;
}

function pageSql(filters: Filters, params: unknown[]): string {
    const all = filterSql(filters, params);
    const rowFilters = filterSql(filters, params, FILTER_FIELDS);
    const typeList = `lower(btrim(COALESCE(transaction_type, ''))) IN (${MODEL_REVENUE_TYPES.map(t => `'${t}'`).join(', ')})`;
    const namedCreator = `btrim(COALESCE(creator, '')) NOT IN ('', 'Unknown', 'None', 'nan')`;
    const eur = `CASE currency WHEN 'USD' THEN revenue / $3 WHEN 'EUR' THEN revenue END`;
    return `
WITH ${PAGE_ROWS_CTE},
model_tx AS (
    SELECT *, ${eur} AS eur FROM tx
    WHERE ${typeList} AND ${rowFilters}
)
SELECT json_build_object(
    'currentRows', (SELECT count(*) FROM page_rows WHERE date BETWEEN $4 AND $5 AND ${all}),
    'previousRows', (SELECT count(*) FROM page_rows WHERE date BETWEEN $6 AND $7 AND ${all}),
    'revenue', (SELECT COALESCE(sum(revenue), 0) FROM page_rows WHERE date BETWEEN $4 AND $5 AND ${all}),
    'previousRevenue', (SELECT COALESCE(sum(revenue), 0) FROM page_rows WHERE date BETWEEN $6 AND $7 AND ${all}),
    'options', ${FILTER_OPTIONS_SQL},
    'modelRevenue', (SELECT json_agg(r) FROM (
        SELECT creator_id, lower(btrim(COALESCE(creator, ''))) AS creator_key,
               EXTRACT(HOUR FROM timezone('Europe/Sarajevo', timestamp))::int AS local_hour,
               date BETWEEN $4 AND $5 AS current, date BETWEEN $6 AND $7 AS previous,
               sum(CASE WHEN lower(btrim(COALESCE(transaction_type, ''))) IN ('tip', 'tips', 'message', 'messages') THEN COALESCE(eur, 0) ELSE 0 END) AS cost
        FROM model_tx
        GROUP BY 1, 2, 3, 4, 5
    ) r),
    'hasModelRevenueCurrent', EXISTS (SELECT 1 FROM model_tx WHERE date BETWEEN $4 AND $5 AND ${namedCreator} AND eur > 0),
    'hasModelRevenuePrevious', EXISTS (SELECT 1 FROM model_tx WHERE date BETWEEN $6 AND $7 AND ${namedCreator} AND eur > 0)
) AS result`;
}

// Model tiers from Flow's creator accounts (Python: load_postgres_creator_tiers).
async function loadTiers(pool: pg.Pool): Promise<CreatorTier[]> {
    const result = await pool.query<{creator: string | null; creator_id: string | null; tier: string}>(`
        SELECT COALESCE(c.name, ca.username) AS creator, ca.creator_id::text AS creator_id, ca.tier::text AS tier
        FROM creator_accounts ca
        LEFT JOIN creators c ON c.id = ca.creator_id
        WHERE COALESCE(ca.tier::text, '') <> ''
        ORDER BY ca.id`);
    return result.rows.map(r => ({creatorId: r.creator_id ?? '', creator: r.creator, tier: r.tier}));
}

function unknown(value: string | null): string {
    return value === null || value === '' ? 'Unknown' : value;
}

function isAssigned(chatter: string): boolean {
    const name = chatter.trim();
    return name !== '' && name.toLowerCase() !== 'unknown';
}

function byChatter(rows: PricedEpisode[]): ChatterInactivity[] {
    const groups = new Map<string, PricedEpisode[]>();
    for (const row of rows) groups.set(row.chatter!, [...(groups.get(row.chatter!) ?? []), row]);
    const table = [...groups].map(([chatter, own]) => {
        const totalHours = own.reduce((s, r) => s + r.inactiveMinutes, 0) / 60;
        const money = own.reduce((s, r) => s + r.moneyWasted, 0);
        const platforms = [...new Set(own.map(r => String(r.platform)).filter(p => p && p !== 'Unknown'))].sort();
        return {
            chatter,
            events: own.length,
            creators: new Set(own.map(r => r.creator)).size,
            platforms: platforms.join(', ') || 'Unknown',
            peakUnread: Math.max(...own.map(r => r.peakUnread)),
            totalHours,
            maxHours: Math.max(...own.map(r => r.inactiveMinutes)) / 60,
            moneyWasted: money,
            avgCostPerHour: totalHours ? money / totalHours : 0,
        };
    });
    return table.sort((a, b) => b.moneyWasted - a.moneyWasted);
}

function summary(rows: PricedEpisode[], table: ChatterInactivity[]): InactivitySummary {
    if (!rows.length) return {events: 0, peakUnread: 0, totalHours: 0, moneyWasted: 0, worstChatter: null, worstMoney: 0};
    return {
        events: rows.length,
        peakUnread: Math.trunc(Math.max(...rows.map(r => r.peakUnread))),
        totalHours: rows.reduce((s, r) => s + r.inactiveMinutes, 0) / 60,
        moneyWasted: rows.reduce((s, r) => s + r.moneyWasted, 0),
        worstChatter: table[0]?.chatter ?? null,
        worstMoney: table[0]?.moneyWasted ?? 0,
    };
}

const TIER_ORDER: Record<string, number> = {A: 0, B: 1, C: 2, Unassigned: 3};

function byTier(rows: PricedEpisode[], shifts: ShiftInput[], tiers: ReturnType<typeof tierMaps>): TierInactivity[] {
    const groups = new Map<string, PricedEpisode[]>();
    for (const row of rows) {
        const tier = row.creatorTier || 'Unassigned';
        groups.set(tier, [...(groups.get(tier) ?? []), row]);
    }
    // Worked hours of every shift in the period, by the model's tier.
    const shiftHours = new Map<string, number>();
    for (const s of shifts) {
        const tier = tiers.byId.get(s.creatorId.trim()) ?? tiers.byName.get(creatorKey(s.creator)) ?? '';
        const key = tier || 'Unassigned';
        shiftHours.set(key, (shiftHours.get(key) ?? 0) + s.shiftHours);
    }
    return [...groups].map(([creatorTier, own]) => {
        const scheduledHours = own.reduce((s, r) => s + r.inactiveMinutes, 0) / 60;
        const money = own.reduce((s, r) => s + r.moneyWasted, 0);
        const worked = shiftHours.get(creatorTier) ?? 0;
        return {
            creatorTier,
            events: own.length,
            models: new Set(own.map(r => r.creator)).size,
            scheduledHours,
            moneyWasted: money,
            shiftHours: worked,
            inactivityPct: worked ? scheduledHours / worked * 100 : 0,
            avgCostPerHour: scheduledHours ? money / scheduledHours : 0,
        };
    }).sort((a, b) => ((TIER_ORDER[a.creatorTier] ?? 9) - (TIER_ORDER[b.creatorTier] ?? 9)) || (a.creatorTier < b.creatorTier ? -1 : 1));
}

function firstBy(table: ChatterInactivity[], key: keyof ChatterInactivity): ChatterInactivity {
    return [...table].sort((a, b) => (b[key] as number) - (a[key] as number))[0];
}

export async function inactivity(pool: pg.Pool, input: InactivityInput): Promise<Inactivity> {
    const {start, end, compare, filters} = input;
    const [compareStart, compareEnd] = comparisonRange(start, end, compare);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const loadStart = minDate(start, compareStart);
    const loadEnd = maxDate(end, compareEnd);

    const pageParams: unknown[] = [loadStart, loadEnd, rate, start, end, compareStart, compareEnd];
    const rowParams: unknown[] = [loadStart, loadEnd];
    const shiftWhere = filterSql(filters, rowParams, FILTER_FIELDS);
    const [page, shiftResult, episodeResult, tierRows] = await Promise.all([
        pool.query<{result: PageQueryResult}>(pageSql(filters, pageParams), pageParams),
        pool.query<ShiftRow>(`SELECT * FROM (${SHIFT_ROWS_SQL}) s WHERE ${shiftWhere}`, rowParams),
        pool.query<EpisodeRow>(`SELECT * FROM (${INACTIVITY_ROWS_SQL}) i WHERE ${shiftWhere}`, rowParams),
        loadTiers(pool),
    ]);
    const p = page.rows[0].result;
    const tiers = tierMaps(tierRows);

    const shifts = shiftResult.rows.map(s => ({
        date: String(s.date),
        input: {
            creatorId: s.creator_id ?? '', creator: s.creator, chatterId: s.chatter_id ?? '', chatter: s.chatter,
            startUs: Number(s.start_us), endUs: s.end_us === null ? null : Number(s.end_us), shiftHours: Number(s.shift_hours) || 0,
        } satisfies ShiftInput,
    }));
    const episodes = episodeResult.rows.map(e => ({
        date: String(e.date),
        input: {
            key: `inactivity|${e.episode_id}|${e.chatter_id ?? ''}`,
            creatorId: e.creator_id ?? '', creator: e.creator, chatterId: e.chatter_id ?? '', chatter: e.chatter,
            startUs: Number(e.start_us), endUs: e.end_us === null ? null : Number(e.end_us),
            inactiveMinutes: Number(e.inactive_minutes) || 0, peakUnread: Number(e.peak_unread_chats) || 0,
            platform: e.platform, team: e.team,
        } satisfies EpisodeInput,
    }));

    function period(from: IsoDate, to: IsoDate, flag: 'current' | 'previous', hasRevenue: boolean) {
        const periodShifts = shifts.filter(s => s.date >= from && s.date <= to).map(s => s.input);
        const periodEpisodes = episodes.filter(e => e.date >= from && e.date <= to).map(e => e.input);
        const revenue: RevenueInput[] = hasRevenue
            ? (p.modelRevenue ?? []).filter(r => r[flag]).map(r => ({creatorId: r.creator_id ?? '', creatorKey: r.creator_key, localHour: r.local_hour, revenue: Number(r.cost)}))
            : [];
        // Missing names become "Unknown" after matching, as in the Python app.
        const matched = matchEpisodesToShifts(periodEpisodes, periodShifts).map(e => ({
            ...e, chatter: unknown(e.chatter), creator: unknown(e.creator), platform: unknown(e.platform), team: unknown(e.team),
        }));
        const priced = priceEpisodes(matched, periodShifts, revenue, tiers).filter(e => isAssigned(e.chatter!));
        return {priced, shifts: periodShifts};
    }

    const current = period(start, end, 'current', p.hasModelRevenueCurrent);
    const previous = period(compareStart, compareEnd, 'previous', p.hasModelRevenuePrevious);
    const chatters = byChatter(current.priced);
    const previousChatters = byChatter(previous.priced);

    return {
        period: {start, end, compare, compareStart, compareEnd},
        eurUsdRate: rate,
        comparison: {
            currentRevenue: p.currentRows ? p.revenue : null,
            previousRevenue: p.previousRows ? p.previousRevenue : null,
        },
        currentEpisodes: current.priced,
        current: summary(current.priced, chatters),
        previous: summary(previous.priced, previousChatters),
        tiers: byTier(current.priced, current.shifts, tiers),
        chatters,
        insights: chatters.length ? {
            topMoney: firstBy(chatters, 'moneyWasted'),
            topUnread: firstBy(chatters, 'peakUnread'),
            topHours: firstBy(chatters, 'totalHours'),
        } : null,
        filterOptions: filterOptions(p.options),
    };
}
