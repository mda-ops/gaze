import type pg from 'pg';
import {filterSql, type Filters} from '../lib/filters.js';
import {comparisonRange, maxDate, minDate, type IsoDate} from '../lib/period.js';
import {pyFixed} from '../lib/py-format.js';
import {liveLoader, modelSocialsData, adsData, ofNewFansData, type Loader, type Table} from '../lib/looker/sources.js';
import {readCsv} from '../lib/looker/frame.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import {INACTIVITY_ROWS_SQL} from '../queries/activity.js';
import {FILTER_OPTIONS_SQL, filterOptions, PAGE_ROWS_CTE, type FilterOptions, type RawFilterOptions} from '../queries/page-rows.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// /weekly-report and /monthly-report (Python app: reports.py
// generate_report, management_summary, formatted_report): Slack-style text.
// The weekly report counts tips and messages only.

export type ReportKind = 'weekly' | 'monthly';

export interface ReportInput {
    kind: ReportKind;
    start: IsoDate;
    end: IsoDate;
    compare: string;
    filters: Filters;
    currentYear: number;
    loader?: Loader;
    eurUsdRate?: number;
}

export interface Report {
    period: {start: IsoDate; end: IsoDate; compare: string; compareStart: IsoDate; compareEnd: IsoDate};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    managementSummary: string;
    report: string;
    filterOptions: FilterOptions;
}

const TIP_TYPES = ['tip', 'tips', 'message', 'messages'];

// reports.py money(): whole euros (or dollars).
const money = (value: number | null, currency: 'EUR' | 'USD' = 'EUR') =>
    (value === null || Number.isNaN(value) ? 'n/a' : `${currency === 'EUR' ? '€' : '$'}${pyFixed(value, 0)}`);
const pct = (value: number | null) => (value === null || Number.isNaN(value) ? 'n/a' : `${pyFixed(value, 1, false)}%`);
const pctChange = (current: number, previous: number) => (previous ? (current - previous) / previous * 100 : null);

// reports.py clean_name: missing, "nan", "none" and "unknown" names.
function cleanName(value: string | null, fallback = 'Unassigned'): string {
    if (value === null) return fallback;
    const text = value.trim();
    return !text || ['nan', 'none', 'unknown'].includes(text.toLowerCase()) ? fallback : text;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function rangeTitle(start: IsoDate, end: IsoDate, kind: ReportKind): string {
    const month = (d: IsoDate) => MONTH_NAMES[Number(d.slice(5, 7)) - 1];
    const day = (d: IsoDate) => Number(d.slice(8, 10));
    if (kind === 'monthly') return `monthly - ${month(start)} ${start.slice(0, 4)}`;
    return `week ${Math.floor((day(end) - 1) / 7) + 1} - ${day(start)} ${month(start)} - ${day(end)} ${month(end)}`;
}

function deltaLine(current: number, previous: number, suffix: string): string {
    const change = current - previous;
    const changePct = pctChange(current, previous);
    if (changePct === null) return `:eyes: no previous ${suffix} comparison available`;
    return `${change >= 0 ? ':tada:' : ':small_red_triangle_down:'} ${change >= 0 ? 'increase' : 'decrease'} ${money(Math.abs(change))} - ${pct(Math.abs(changePct))} ${suffix}`;
}

interface Group {
    key: string;
    revenue: number;
    previous: number;
}

const changePctOf = (g: Group) => pctChange(g.revenue, g.previous);

// group_performance order: revenue, highest first (equal revenues by name here).
const byRevenue = (groups: Group[]) => [...groups].sort((a, b) => b.revenue - a.revenue || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
const named = (groups: Group[]) => groups.filter(g => cleanName(g.key, '') !== '');

// group_performance's group key: missing and "" become "Unknown".
const key = (column: string) => `CASE WHEN ${column} IS NULL OR ${column} = '' THEN 'Unknown' ELSE ${column} END`;

function groupsSql(keyExpr: string, extra = ''): string {
    return `(SELECT COALESCE(json_agg(json_build_object('key', c.key, ${extra}'revenue', c.revenue, 'previous', COALESCE(p.revenue, 0))), '[]'::json)
        FROM (SELECT ${keyExpr} AS key, ${extra ? 'upper(COALESCE(platform, \'nan\')) AS platform,' : ''} COALESCE(sum(rev), 0) AS revenue FROM cur GROUP BY 1${extra ? ', 2' : ''}) c
        LEFT JOIN (SELECT ${keyExpr} AS key, ${extra ? 'upper(COALESCE(platform, \'nan\')) AS platform,' : ''} sum(rev) AS revenue FROM prev GROUP BY 1${extra ? ', 2' : ''}) p
        ON p.key = c.key${extra ? ' AND p.platform = c.platform' : ''})`;
}

interface ResultRow {
    currentRows: number;
    previousRows: number;
    revenue: number;
    previousRevenue: number;
    allRevenue: number;
    allPreviousRevenue: number;
    hours: number;
    chatters: Group[];
    creators: Group[];
    platforms: Group[];
    platformCreators: (Group & {platform: string})[];
    platformTotals: {platform: string; revenue: number; previous: number}[];
    options: RawFilterOptions;
}

interface InactivityRow {
    chatter: string | null;
    inactive_minutes: number | null;
    inactivity_money_wasted: number | null;
    peak_unread_chats: number | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));

// reports.py inactivity_lines.
async function inactivityLines(rows: InactivityRow[], start: IsoDate, end: IsoDate): Promise<string[]> {
    const lines = [':eyes: **INACTIVITY**'];
    if (rows.length) {
        const assigned = rows
            .map(r => ({...r, chatter: r.chatter === null || r.chatter === '' ? 'Unknown' : r.chatter}))
            .filter(r => !['', 'unknown'].includes(r.chatter.trim().toLowerCase()));
        if (!assigned.length) {
            lines.push('No chatter-specific inactivity was found for this date range.');
            return lines;
        }
        const num = (v: number | null) => (v === null || Number.isNaN(v) ? 0 : v);
        const groups = new Map<string, {maxUnread: number; minutes: number; maxMinutes: number; money: number}>();
        for (const r of assigned) {
            const g = groups.get(r.chatter) ?? {maxUnread: -Infinity, minutes: 0, maxMinutes: -Infinity, money: 0};
            g.maxUnread = Math.max(g.maxUnread, num(r.peak_unread_chats));
            g.minutes += num(r.inactive_minutes);
            g.maxMinutes = Math.max(g.maxMinutes, num(r.inactive_minutes));
            g.money += num(r.inactivity_money_wasted);
            groups.set(r.chatter, g);
        }
        // Sorted by money, then peak unread, then hours; equal rows keep name order.
        const ranked = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .sort(([, a], [, b]) => b.money - a.money || b.maxUnread - a.maxUnread || b.minutes - a.minutes);
        lines.push(`highest unread: ${pyFixed(Math.max(...assigned.map(r => num(r.peak_unread_chats))), 0)}`);
        lines.push(`total inactive hours: ${pyFixed(assigned.reduce((s, r) => s + num(r.inactive_minutes), 0) / 60, 1)}h`);
        lines.push(`estimated money wasted: ${money(assigned.reduce((s, r) => s + num(r.inactivity_money_wasted), 0))}`);
        lines.push(':eyes: pattern to watch');
        for (const [chatter, g] of ranked.slice(0, 6)) {
            lines.push(`${chatter} - ${pyFixed(Math.trunc(g.maxUnread), 0)} peak unread - ${pyFixed(g.maxMinutes / 60, 1, false)}h max inactive - ${money(g.money)} wasted`);
        }
        return lines;
    }
    // Without inactivity rows: the cached Inactivity Monitor export.
    let monitor: Record<string, unknown>[] = [];
    try {
        const frame = readCsv(await fs.readFile(path.join(here, '..', '..', 'data', 'looker_sources', 'inactivity_monitor.csv'), 'utf-8'));
        monitor = frame.rows.filter(r => r.view === 'Chatter' && String(r.date_to ?? '').slice(0, 10) >= start && String(r.date_from ?? '').slice(0, 10) <= end);
    } catch { /* no export: same as an empty one */ }
    if (!monitor.length) {
        lines.push('Inactivity detail is not connected for this date range yet.');
        return lines;
    }
    const n = (r: Record<string, unknown>, c: string) => (typeof r[c] === 'number' ? r[c] as number : Number(r[c]) || 0);
    lines.push(`highest unread: ${Math.max(...monitor.map(r => n(r, 'max_unread')))}`);
    lines.push(`total inactive hours: ${pyFixed(monitor.reduce((s, r) => s + n(r, 'total_hours'), 0), 1)}h`);
    lines.push(`estimated money wasted: ${money(monitor.reduce((s, r) => s + n(r, 'money_wasted'), 0))}`);
    lines.push(':eyes: pattern to watch');
    for (const r of [...monitor].sort((a, b) => n(b, 'max_unread') - n(a, 'max_unread') || n(b, 'total_hours') - n(a, 'total_hours')).slice(0, 6)) {
        lines.push(`${r.name} - ${Math.trunc(n(r, 'max_unread'))} max unread - ${pyFixed(n(r, 'max_hours'), 1, false)}h max inactive`);
    }
    return lines;
}

const tableSum = (table: Table, column: string) => {
    const at = table.columns.indexOf(column);
    return at < 0 ? 0 : table.rows.reduce((s, r) => s + (typeof r[at] === 'number' && !Number.isNaN(r[at]) ? r[at] as number : 0), 0);
};

export async function report(pool: pg.Pool, input: ReportInput): Promise<Report> {
    const {kind, start, end, compare, filters, currentYear, loader = liveLoader} = input;
    const [compareStart, compareEnd] = comparisonRange(start, end, compare);
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const params: unknown[] = [minDate(start, compareStart), maxDate(end, compareEnd), rate, start, end, compareStart, compareEnd];
    const where = filterSql(filters, params);
    // Weekly: every non-tip/message row counts as 0 revenue (reports.py tips_messages_revenue_only).
    const rev = kind === 'weekly'
        ? `CASE WHEN lower(btrim(COALESCE(transaction_type, ''))) IN (${TIP_TYPES.map(t => `'${t}'`).join(', ')}) THEN revenue ELSE 0 END`
        : 'revenue';

    const inactivityParams: unknown[] = [start, end];
    const inactivityWhere = filterSql(filters, inactivityParams);
    const [result, inactivityResult, ads, socials, fans] = await Promise.all([
        pool.query<{result: ResultRow}>(`
WITH ${PAGE_ROWS_CTE},
cur AS MATERIALIZED (SELECT *, ${rev} AS rev FROM page_rows WHERE date BETWEEN $4 AND $5 AND ${where}),
prev AS MATERIALIZED (SELECT *, ${rev} AS rev FROM page_rows WHERE date BETWEEN $6 AND $7 AND ${where})
SELECT json_build_object(
    'currentRows', (SELECT count(*) FROM cur),
    'previousRows', (SELECT count(*) FROM prev),
    'revenue', (SELECT COALESCE(sum(rev), 0) FROM cur),
    'previousRevenue', (SELECT COALESCE(sum(rev), 0) FROM prev),
    -- The comparison strip shows all revenue, also on the weekly report.
    'allRevenue', (SELECT COALESCE(sum(revenue), 0) FROM cur),
    'allPreviousRevenue', (SELECT COALESCE(sum(revenue), 0) FROM prev),
    'hours', (SELECT COALESCE(sum(shift_hours), 0) FROM cur),
    'chatters', ${groupsSql(key('chatter'))},
    'creators', ${groupsSql(key('creator'))},
    'platforms', ${groupsSql(key('platform'))},
    'platformCreators', ${groupsSql(key('creator'), "'platform', c.platform, ")},
    'platformTotals', (SELECT COALESCE(json_agg(json_build_object('platform', platform, 'revenue', revenue, 'previous', previous)), '[]'::json) FROM (
        SELECT p, COALESCE((SELECT sum(rev) FROM cur WHERE upper(COALESCE(platform, 'nan')) = p), 0) AS revenue,
               COALESCE((SELECT sum(rev) FROM prev WHERE upper(COALESCE(platform, 'nan')) = p), 0) AS previous,
               p AS platform
        FROM unnest(ARRAY['F2F', 'KNKY', 'OF']) p
    ) t),
    'options', ${FILTER_OPTIONS_SQL}
) AS result`, params),
        pool.query<InactivityRow>(`SELECT chatter, inactive_minutes, inactivity_money_wasted, peak_unread_chats
            FROM (${INACTIVITY_ROWS_SQL}) i WHERE date BETWEEN $1 AND $2 AND ${inactivityWhere}`, inactivityParams),
        adsData(loader, start, end, currentYear),
        modelSocialsData(loader, start, end, currentYear),
        ofNewFansData(loader, start, end, currentYear),
    ]);
    const r = result.rows[0].result;

    const creators = named(byRevenue(r.creators));
    const chatters = named(byRevenue(r.chatters));
    const platforms = named(byRevenue(r.platforms));
    const suffix = kind === 'monthly' ? 'MoM' : 'WoW';
    const title = rangeTitle(start, end, kind);
    const revenuePerHour = r.hours ? r.revenue / r.hours : null;

    const insights: string[] = [];
    if (creators.length) {
        insights.push(`:tada: ${cleanName(creators[0].key)} led model revenue with ${money(creators[0].revenue)}.`);
        const climbers = creators.filter(g => changePctOf(g) !== null).sort((a, b) => changePctOf(b)! - changePctOf(a)!).slice(0, 2);
        for (const g of climbers) {
            if (changePctOf(g)! > 0) insights.push(`:tada: ${cleanName(g.key)} improved ${pct(changePctOf(g))} vs previous period.`);
        }
    }
    if (chatters.length) insights.push(`:warning: top chatter was ${cleanName(chatters[0].key)} at ${money(chatters[0].revenue)}.`);
    if (platforms.length) insights.push(`:eyes: strongest platform was ${cleanName(platforms[0].key)} at ${money(platforms[0].revenue)}.`);
    if (!insights.length) insights.push(':eyes: detailed entity insights need imported creator, chatter, and platform data for the selected period.');

    const summaryLines = [title, '', `Total revenue landed at ${money(r.revenue)}. ${deltaLine(r.revenue, r.previousRevenue, suffix)}`];
    if (revenuePerHour) summaryLines.push(`Revenue per hour was ${money(revenuePerHour)}.`);
    const topCreators = creators.slice(0, 8);
    const topChatters = chatters.slice(0, 10);
    if (topCreators.length) summaryLines.push(`Top model was ${cleanName(topCreators[0].key)} at ${money(topCreators[0].revenue)}.`);
    if (topChatters.length) summaryLines.push(`Top chatter was ${cleanName(topChatters[0].key)} at ${money(topChatters[0].revenue)}.`);
    summaryLines.push(...insights.slice(0, 5));

    const platformTop = platforms.slice(0, 8);
    const platformLines = platformTop.length
        ? ([['F2F', ':purple_heart:'], ['KNKY', ':pink_heart:'], ['OF', ':blue_heart:']] as const).map(([p, icon]) =>
            `${icon} ${p}: ${money(platformTop.find(g => g.key.toUpperCase() === p)?.revenue ?? 0)}`)
        : [':purple_heart: F2F: n/a', ':pink_heart: KNKY: n/a', ':blue_heart: OF: n/a'];
    const compact = (groups: Group[], limit: number) =>
        (groups.length ? groups.slice(0, limit).map(g => `${cleanName(g.key)} ${money(g.revenue)}`) : ['No ranked data available yet.']);

    const lines = [title, '', ':speech_balloon: **CHAT DEPT**', `OVERALL ${kind} rev: ${money(r.revenue)}`, deltaLine(r.revenue, r.previousRevenue, suffix), '',
        ...platformLines, '', ':trophy: **MODELS**', ...compact(topCreators, 5), ''];
    for (const [p, icon] of [['F2F', ':purple_heart:'], ['KNKY', ':pink_heart:'], ['OF', ':blue_heart:']] as const) {
        lines.push(`**${p}** ${icon}`);
        const total = r.platformTotals.find(t => t.platform === p)!;
        const change = pctChange(total.revenue, total.previous);
        if (change === null) lines.push(':eyes: no previous comparison available');
        else {
            const up = total.revenue >= total.previous;
            lines.push(`${up ? ':tada:' : ':small_red_triangle_down:'} ${p} ${up ? 'increased' : 'dropped'} ${pct(Math.abs(change))} vs previous period`);
        }
        for (const g of byRevenue(r.platformCreators.filter(c => c.platform === p)).slice(0, 5)) {
            const c = changePctOf(g);
            const badge = c === null ? ':eyes:' : c >= 0 ? ':tada:' : ':small_red_triangle_down:';
            lines.push(`${badge} ${cleanName(g.key)} ${money(g.revenue)}${c === null ? '' : ` - ${c >= 0 ? 'up' : 'down'} ${pct(Math.abs(c))}`}`);
        }
        lines.push('');
    }
    lines.push(':trophy: **TOP CHATTERS**', ...compact(topChatters, 10), '');
    lines.push(...await inactivityLines(inactivityResult.rows, start, end));

    const adsLines = ads.raw.rows.length
        ? [':mega: **BD ADS**', `:money_with_wings: total BD ad spend: ${money(tableSum(ads.raw, 'spend_num'), 'USD')}`, `clicks: ${pyFixed(tableSum(ads.raw, 'clicks_num'), 0)}`]
        : [':mega: **BD ADS**', 'BD ads data is not available for this date range.'];
    const modelAt = socials.byModel.columns.indexOf('Model');
    const topReachRow = socials.byModel.rows.find(row => cleanName(row[modelAt] === null ? null : String(row[modelAt]), '') !== '');
    const marketingLines = socials.raw.rows.length
        ? [':iphone: **MKTG**',
            `IG impressions: ${pyFixed(tableSum(socials.raw, 'impressions'), 0)}`,
            `profile visits: ${pyFixed(tableSum(socials.raw, 'profile_visits'), 0)}`,
            `net followers gained: ${pyFixed(tableSum(socials.raw, 'followers_gained'), 0)}`,
            `organic link clicks: ${pyFixed(tableSum(socials.raw, 'bio_clicks'), 0)}`,
            `:tada: ${topReachRow ? cleanName(String(topReachRow[modelAt]), 'top account') : 'top account'} had the strongest reach in the selected period`]
        : [':iphone: **MKTG**', 'Marketing socials data is not available for this date range.'];
    const fansLines = [':dancer: **OF New Subs:**'];
    if (!fans.byModel.rows.length) fansLines.push('OF new fan data is not available for this date range.');
    else {
        const m = fans.byModel.columns.indexOf('model');
        const v = fans.byModel.columns.indexOf('new_fans');
        for (const row of fans.byModel.rows.slice(0, 5)) fansLines.push(`${pyFixed(Math.trunc(Number(row[v])), 0)} - ${row[m]}`);
    }
    lines.push('', ...adsLines, '', ...marketingLines, '', ...fansLines);
    lines.push('', ':handshake: **BD**', 'BD leads, meetings, and signed deals need the BD source connected.', '',
        ':art: **CREATIVE DIRECTING**', 'Creative output data needs the creative tracking source connected.', '',
        ':busts_in_silhouette: **HR**', 'HR applicant, offer, onboarding, resignation, and termination data needs the HR source connected.', '',
        ':rotating_light: **OVERALL**', ...insights.slice(0, 8));

    return {
        period: {start, end, compare, compareStart, compareEnd},
        eurUsdRate: rate,
        comparison: {currentRevenue: r.currentRows ? r.allRevenue : null, previousRevenue: r.previousRows ? r.allPreviousRevenue : null},
        managementSummary: summaryLines.join('\n'),
        report: lines.join('\n'),
        filterOptions: filterOptions(r.options),
    };
}
