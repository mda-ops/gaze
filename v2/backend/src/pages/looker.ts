import type {IsoDate} from '../lib/period.js';
import {pyCompact, pyFixed, pyMoney} from '../lib/py-format.js';
import type {Value} from '../lib/looker/frame.js';
import {
    adsData, complianceData, liveLoader, modelSocialsData, ofNewFansData, SOURCES, ticketsData,
    type Card, type Loader, type Table,
} from '../lib/looker/sources.js';

// The Hub pages (/compliance-dash, /marketing, ...) and their C Hub versions
// (/c-hub/compliance, ...): Python app handlers of the same names. Cards are
// worded and formatted here exactly as there; amounts are always euros.

// A chart: rows with a label and value, how the page formats values, and
// how many bars it shows (Python: c_horizontal_chart / c_column_chart).
export interface Chart {
    rows: {label: string; value: number}[];
    format: 'money' | 'compact' | 'score';
    limit: number;
}

export interface SourceNote {
    title: string;
    url: string;
    tabs: string;
    extra: string;
}

// pandas to_numeric(errors="coerce").fillna(0) of one cell.
function toNumeric(value: Value | undefined): number {
    if (typeof value === 'number') return Number.isNaN(value) ? 0 : value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value !== 'string') return 0;
    const text = value.trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
    return 0;
}

const column = (table: Table, name: string) => table.columns.indexOf(name);

// Python: safe_sum.
function safeSum(table: Table, name: string): number {
    const at = column(table, name);
    return at < 0 ? 0 : table.rows.reduce((sum, r) => sum + toNumeric(r[at]), 0);
}

// Python: raw_numeric_total. The first listed column that exists, with every
// character but digits, "." and "-" removed.
function rawNumericTotal(table: Table, candidates: string[]): number {
    for (const name of candidates) {
        const at = column(table, name);
        if (at < 0) continue;
        return table.rows.reduce((sum, r) => {
            const v = r[at];
            const text = (v === null ? 'nan' : String(v)).replace(/[^0-9.-]/g, '');
            return sum + toNumeric(text === '' ? '0' : text);
        }, 0);
    }
    return 0;
}

// A chart label: Python str() of the cell, "nan" when missing.
const label = (v: Value | undefined) => (v === null || v === undefined ? 'nan' : String(v));

function chart(table: Table, labelColumn: string, valueColumn: string, format: Chart['format'], limit: number): Chart {
    const l = column(table, labelColumn);
    const v = column(table, valueColumn);
    if (l < 0 || v < 0) return {rows: [], format, limit};
    return {rows: table.rows.map(r => ({label: label(r[l]), value: toNumeric(r[v])})), format, limit};
}

const tail = (table: Table, n: number): Table => ({columns: table.columns, rows: table.rows.slice(-n)});
const head = (table: Table, n: number): Table => ({columns: table.columns, rows: table.rows.slice(0, n)});

function sourceNote(key: keyof typeof SOURCES, extra: string): SourceNote {
    const s = SOURCES[key];
    return {title: s.title, url: s.url, tabs: s.tabs.join(', '), extra};
}

export interface LookerInput {
    start: IsoDate;
    end: IsoDate;
    currentYear: number;
    loader?: Loader;
}

// ---- Hub pages ------------------------------------------------------------

export async function complianceDash({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await complianceData(loader, start, end, currentYear);
    return {source: sourceNote('compliance', ' · cached from accessible Looker source.'), cards: data.cards, latest: data.latest, metrics: data.metrics};
}

export async function marketing({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const [ads, socials, fans] = await Promise.all([
        adsData(loader, start, end, currentYear), modelSocialsData(loader, start, end, currentYear), ofNewFansData(loader, start, end, currentYear),
    ]);
    const cards: Card[] = [...ads.cards.slice(0, 3), ['New OF Fans', fans.cards.length ? fans.cards[0][1] : 'n/a', 'from OFNewFans']];
    return {
        source: sourceNote('marketing', ' · marketing, ads, socials, and OF fan tabs are cached.'),
        cards, adsByPlatform: ads.byPlatform, socialsByModel: socials.byModel, fansByModel: fans.byModel,
    };
}

export async function modelsSocials({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await modelSocialsData(loader, start, end, currentYear);
    return {source: sourceNote('marketing', ' · using LisaModelsRaw.'), cards: data.cards, byModel: data.byModel, byPlatform: data.byPlatform, recent: tail(data.raw, 100)};
}

export async function ofNewFanGrowth({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await ofNewFansData(loader, start, end, currentYear);
    return {source: sourceNote('marketing', ' · using OFNewFans.'), cards: data.cards, byModel: data.byModel, daily: tail(data.daily, 100)};
}

export async function adsPerformance({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await adsData(loader, start, end, currentYear);
    return {source: sourceNote('marketing', ' · using MDAds.'), cards: data.cards, byPlatform: data.byPlatform, byCampaign: data.byCampaign, recent: tail(data.raw, 100)};
}

export async function notionTickets({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await ticketsData(loader, start, end, currentYear);
    return {
        source: sourceNote('tickets', ' · cached from RAW - Notion Tickets.'),
        cards: data.cards, byDepartmentStatus: data.byDepartmentStatus, byStatus: data.byStatus, tickets: data.tickets,
    };
}

// ---- C Hub pages ----------------------------------------------------------

export async function cHubCompliance({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await complianceData(loader, start, end, currentYear);
    const latest = data.latest;
    const n = latest.rows.length;
    const avgBest = n ? safeSum(latest, 'Best Score') / Math.max(1, n) : 0;
    const avgWorst = n ? safeSum(latest, 'Worst Score') / Math.max(1, n) : 0;
    const cards: Card[] = [
        ['Avg Best Score', `${pyFixed(avgBest, 1, false)}/100`, 'latest quality'],
        ['Avg Risk Score', `${pyFixed(avgWorst, 1, false)}/100`, 'lowest performer read'],
        ['Pillars', String(n), 'quality areas'],
        ['Latest Evaluation', data.cards.length ? data.cards[0][1] : 'n/a', 'source date'],
    ];
    return {
        cards,
        bestByPillar: chart(latest, 'Pillar', 'Best Score', 'score', 7),
        worstByPillar: chart(latest, 'Pillar', 'Worst Score', 'score', 7),
        latest,
    };
}

export async function cHubMarketingAds({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await adsData(loader, start, end, currentYear);
    const campaigns = data.byCampaign;
    const spendAt = column(campaigns, 'ad_spend');
    const clicksAt = column(campaigns, 'clicks');
    const byCampaign: Table = campaigns.rows.length
        ? {columns: [...campaigns.columns, 'cpl'], rows: campaigns.rows.map(r => [...r, Number(r[clicksAt]) ? Number(r[spendAt]) / Number(r[clicksAt]) : 0])}
        : campaigns;
    const spend = safeSum(data.byPlatform, 'ad_spend');
    const clicks = safeSum(data.byPlatform, 'clicks');
    const signed = safeSum(data.byPlatform, 'leads_signed');
    const cards: Card[] = [
        ['Ad Spend', pyMoney(spend), 'MTD selected source'],
        ['Leads', pyCompact(clicks), 'link clicks'],
        ['CPL', clicks ? pyMoney(spend / clicks) : '-', 'cost per lead'],
        ['Signed', pyCompact(signed), 'reported'],
        ['CPA', signed ? pyMoney(spend / signed) : '-', 'cost per acquisition'],
    ];
    let notice: string | null = null;
    if (data.source) {
        const live = data.source === 'Live Google Sheet';
        notice = `${live ? 'Live MDAds Google Sheet' : 'Cached MDAds snapshot'}.`
            + (data.latestSourceDate ? ` Latest source date: ${data.latestSourceDate}.` : '')
            + (live ? '' : ' The live sheet could not be reached, so this page is using the cached export.');
    }
    return {
        cards,
        notice,
        spendByCampaign: chart(byCampaign, 'Campaign Name', 'ad_spend', 'money', 8),
        leadsByPlatform: chart(data.byPlatform, 'Platform', 'clicks', 'compact', 8),
        leadsByCampaign: chart(byCampaign, 'Campaign Name', 'clicks', 'compact', 8),
        cplByCampaign: chart(byCampaign, 'Campaign Name', 'cpl', 'money', 8),
    };
}

export async function cHubModelsSocials({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await modelSocialsData(loader, start, end, currentYear);
    const raw = data.raw;
    const distinct = (name: string) => {
        const at = column(raw, name);
        return at < 0 ? 0 : new Set(raw.rows.map(r => r[at]).filter(v => v !== null)).size;
    };
    const cards: Card[] = [
        ['Number of Models', String(distinct('Model')), 'active source rows'],
        ['Number of Accounts', String(distinct('Account')), 'social accounts'],
        ['Impressions', pyCompact(safeSum(data.byModel, 'impressions')), 'social traffic'],
        ['Profile Visits', pyCompact(safeSum(data.byModel, 'profile_visits')), 'profile traffic'],
        ['Bio Link Clicks', pyCompact(rawNumericTotal(raw, ['Bio Link Clicks'])), 'link intent'],
        ['Followers Total', pyCompact(rawNumericTotal(raw, ['Followers Total Socials'])), 'social base'],
        ['Adult Click Throughs', pyCompact(rawNumericTotal(raw, ['Adult Click Throughs', 'Adult\nClick Throughs'])), 'OF conversion'],
        ['Subscriptions OF', pyCompact(rawNumericTotal(raw, ['Subscriptions (OF)'])), 'OF growth'],
    ];
    return {
        cards,
        reachByModel: chart(data.byModel, 'Model', 'impressions', 'compact', 8),
        visitsByModel: chart(data.byModel, 'Model', 'profile_visits', 'compact', 8),
        subscriptionsByModel: chart(data.byModel, 'Model', 'subscriptions', 'compact', 8),
        reachByPlatform: chart(data.byPlatform, 'Platform', 'impressions', 'compact', 8),
    };
}

export async function cHubOfNewFans({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await ofNewFansData(loader, start, end, currentYear);
    const raw = data.raw;
    const modelAt = column(data.byModel, 'model');
    const topModels = modelAt < 0 ? [] : head(data.byModel, 4).rows.map(r => String(r[modelAt]));
    const dateAt = column(raw, 'Date');
    // Each top model's daily values, as in the source (not cleaned of "$" etc.).
    const lines = topModels.map(model => {
        const at = raw.columns.findIndex(c => c.trim() === model.trim());
        return {
            model,
            points: at < 0 ? [] : raw.rows.map(r => ({label: dateAt < 0 ? '' : label(r[dateAt]), value: toNumeric(r[at])})),
        };
    });
    return {cards: data.cards, lines, byModel: chart(data.byModel, 'model', 'new_fans', 'compact', 8)};
}

export async function cHubAdsPerformance({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await adsData(loader, start, end, currentYear);
    const raw = data.raw;
    if (!raw.rows.length) return {empty: true as const, cards: [['Ad Spend', 'n/a', 'no rows'], ['Leads', 'n/a', 'no rows']] as Card[]};
    // groupby("Ad Category"): categories in name order, missing last.
    const at = (name: string) => column(raw, name);
    const groups = new Map<string | null, {impressions: number; clicks: number; ad_spend: number; signed: number}>();
    for (const r of raw.rows) {
        const key = r[at('Ad Category')] === null ? null : String(r[at('Ad Category')]);
        const g = groups.get(key) ?? {impressions: 0, clicks: 0, ad_spend: 0, signed: 0};
        g.impressions += Number(r[at('impressions_num')] ?? 0);
        g.clicks += Number(r[at('clicks_num')] ?? 0);
        g.ad_spend += Number(r[at('spend_num')] ?? 0);
        g.signed += Number(r[at('leads_signed_num')] ?? 0);
        groups.set(key, g);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0));
    const category: Table = {
        columns: ['Ad Category', 'impressions', 'clicks', 'ad_spend', 'signed', 'cpl'],
        rows: keys.map(k => {
            const g = groups.get(k)!;
            return [k, g.impressions, g.clicks, g.ad_spend, g.signed, g.clicks ? g.ad_spend / g.clicks : 0];
        }),
    };
    const spend = safeSum(category, 'ad_spend');
    const clicks = safeSum(category, 'clicks');
    const cards: Card[] = [
        ['BD + Hiring Spend', pyMoney(spend), 'total'],
        ['Impressions', pyCompact(safeSum(category, 'impressions')), 'reach'],
        ['Leads', pyCompact(clicks), 'clicks'],
        ['Signed', pyCompact(safeSum(category, 'signed')), 'reported'],
        ['Blended CPL', clicks ? pyMoney(spend / clicks) : '-', 'cost'],
    ];
    return {
        empty: false as const,
        cards,
        spendByCategory: chart(category, 'Ad Category', 'ad_spend', 'money', 6),
        leadsByCategory: chart(category, 'Ad Category', 'clicks', 'compact', 6),
        cplByCategory: chart(category, 'Ad Category', 'cpl', 'money', 6),
        campaignSpend: chart(data.byCampaign, 'Campaign Name', 'ad_spend', 'money', 10),
    };
}

export async function cHubTickets({start, end, currentYear, loader = liveLoader}: LookerInput) {
    const data = await ticketsData(loader, start, end, currentYear);
    let notice: string | null = null;
    if (data.source) {
        const live = data.source === 'Notion API';
        notice = `${live ? 'Live Notion API' : data.source}.`
            + (data.latestCreated ? ` Latest ticket in this view: ${data.latestCreated}.` : '')
            + (live ? '' : ' Add or fix the Notion token in the app environment to use live tickets.');
    }
    return {cards: data.cards, notice, byDepartmentStatus: data.byDepartmentStatus, byStatus: data.byStatus, tickets: data.tickets};
}
