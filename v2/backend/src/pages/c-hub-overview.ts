import type pg from 'pg';
import {emptyFilters} from '../lib/filters.js';
import {comparisonRange, type IsoDate} from '../lib/period.js';
import {pyCompact, pyFixed, pyMoney, pyPct} from '../lib/py-format.js';
import type {Value} from '../lib/looker/frame.js';
import {
    adsData, complianceData, liveLoader, modelSocialsData, ofNewFansData, ticketsData, type Loader, type Table,
} from '../lib/looker/sources.js';
import {inactivity} from './inactivity.js';
import type {Chart} from './looker.js';

// /c-hub, Marketing & Operations Overview (Python app: c_hub): marketing,
// ads, OF fans, tickets, compliance and inactivity for the period, each
// compared with the comparison period.

export interface OverviewInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    currentYear: number;
    loader?: Loader;
    eurUsdRate?: number;
}

export interface MetricCard {
    label: string;
    value: string;
    note: string;
    href: string;
    deltaClass: string;
}

// pandas to_numeric(errors="coerce").fillna(0) of one cell.
function toNumeric(value: Value | undefined): number {
    if (typeof value === 'number') return Number.isNaN(value) ? 0 : value;
    if (typeof value === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value)) return Number(value);
    return 0;
}

const at = (table: Table, name: string) => table.columns.indexOf(name);

// Python: safe_sum.
function safeSum(table: Table, name: string): number {
    const i = at(table, name);
    return i < 0 ? 0 : table.rows.reduce((sum, r) => sum + toNumeric(r[i]), 0);
}

// Python: first_value, the label of the highest value (first of equals here).
function firstValue(table: Table, labelColumn: string, valueColumn: string): string {
    const l = at(table, labelColumn);
    const v = at(table, valueColumn);
    if (!table.rows.length || l < 0 || v < 0) return 'n/a';
    const best = table.rows.reduce((top, r) => (toNumeric(r[v]) > toNumeric(top[v]) ? r : top));
    return best[l] === null ? 'nan' : String(best[l]);
}

// Python: delta_markup.
function delta(current: number, previous: number): [string, string] {
    if (!previous) return ['no prior range', 'delta-neutral'];
    const change = (current - previous) / previous * 100;
    return [`${pyPct(change)} vs previous range`, change > 0 ? 'delta-positive' : change < 0 ? 'delta-negative' : 'delta-neutral'];
}

function chart(table: Table, labelColumn: string, valueColumn: string, format: Chart['format'], limit: number): Chart {
    const l = at(table, labelColumn);
    const v = at(table, valueColumn);
    if (l < 0 || v < 0) return {rows: [], format, limit};
    return {rows: table.rows.map(r => ({label: r[l] === null ? 'nan' : String(r[l]), value: toNumeric(r[v])})), format, limit};
}

export async function cHubOverview(pool: pg.Pool, input: OverviewInput) {
    const {start, end, compare, currentYear, loader = liveLoader} = input;
    const [compareStart, compareEnd] = comparisonRange(start, end, compare);
    // Python: urlencode, so spaces are "+".
    const query = `?${new URLSearchParams({range: 'Custom', start, end, compare})}`;
    const links = {
        socials: `/models-socials${query}`, ads: `/ads-performance${query}`, fans: `/of-new-fan-growth${query}`,
        tickets: `/notion-tickets${query}`, compliance: `/compliance-dash${query}`, inactivity: `/inactivity${query}`,
    };

    const [ads, prevAds, socials, prevSocials, fans, prevFans, tickets, prevTickets, compliance, inactive] = await Promise.all([
        adsData(loader, start, end, currentYear), adsData(loader, compareStart, compareEnd, currentYear),
        modelSocialsData(loader, start, end, currentYear), modelSocialsData(loader, compareStart, compareEnd, currentYear),
        ofNewFansData(loader, start, end, currentYear), ofNewFansData(loader, compareStart, compareEnd, currentYear),
        ticketsData(loader, start, end, currentYear), ticketsData(loader, compareStart, compareEnd, currentYear),
        complianceData(loader, start, end, currentYear),
        inactivity(pool, {start, end, compare, filters: emptyFilters(), eurUsdRate: input.eurUsdRate}),
    ]);

    const adSpend = safeSum(ads.byPlatform, 'ad_spend');
    const impressions = safeSum(socials.byModel, 'impressions');
    const newFans = safeSum(fans.byModel, 'new_fans');
    const ticketCount = safeSum(tickets.byStatus, 'tickets');
    const moneyWasted = inactive.current.moneyWasted;
    const bestAt = at(compliance.latest, 'Best Score');
    const bestScore = compliance.latest.rows.length && bestAt >= 0
        ? compliance.latest.rows.reduce((s, r) => s + toNumeric(r[bestAt]), 0) / compliance.latest.rows.length
        : 0;

    const card = (label: string, value: string, [note, deltaClass]: [string, string], href: string): MetricCard => ({label, value, note, href, deltaClass});
    const cards: MetricCard[] = [
        card('Marketing Reach', pyCompact(impressions), delta(impressions, safeSum(prevSocials.byModel, 'impressions')), links.socials),
        card('BD Ad Spend', pyMoney(adSpend), delta(adSpend, safeSum(prevAds.byPlatform, 'ad_spend')), links.ads),
        card('OF New Fans', pyCompact(newFans), delta(newFans, safeSum(prevFans.byModel, 'new_fans')), links.fans),
        card('Tickets', pyCompact(ticketCount), delta(ticketCount, safeSum(prevTickets.byStatus, 'tickets')), links.tickets),
        card('Inactivity Cost', pyMoney(moneyWasted), delta(moneyWasted, inactive.previous.moneyWasted), links.inactivity),
        card('Quality Score', bestScore ? `${pyFixed(bestScore, 1, false)}/100` : 'n/a', ['latest compliance read', 'delta-neutral'], links.compliance),
    ];

    const insights = [
        `${firstValue(socials.byModel, 'Model', 'impressions')} is the strongest social reach driver in the selected range.`,
        `${firstValue(ads.byPlatform, 'Platform', 'ad_spend')} carries the highest ad spend and should be checked against click quality.`,
        `${firstValue(fans.byModel, 'model', 'new_fans')} leads OF new fan growth for this period.`,
        `Inactivity exposure is ${pyMoney(moneyWasted)}, with ${inactive.current.worstChatter ?? 'n/a'} as the highest-cost chatter row.`,
        `Tickets are at ${pyCompact(ticketCount)} for the selected range; click the ticket chart to inspect status and owners.`,
    ];

    return {
        comparePeriod: {compare, compareStart, compareEnd},
        links,
        cards,
        topSocialReach: chart(socials.byModel, 'Model', 'impressions', 'compact', 7),
        adSpend: chart(ads.byPlatform, 'Platform', 'ad_spend', 'money', 6),
        ticketStatus: tickets.byStatus,
        newFans: chart(fans.byModel, 'model', 'new_fans', 'compact', 7),
        complianceScores: chart(compliance.latest, 'Pillar', 'Best Score', 'score', 7),
        insights,
    };
}
