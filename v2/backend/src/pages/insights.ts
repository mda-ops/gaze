import type pg from 'pg';
import type {Filters} from '../lib/filters.js';
import type {IsoDate} from '../lib/period.js';
import {pyFixed, pyMoney} from '../lib/py-format.js';
import {coreAnalysis, type CoreAnalysis, type Group, type GroupRow} from './core-analysis.js';

// /insights (Python app: insights.py factual_insights and anomalies). The
// sentences are built here, word for word as in the Python app; amounts are
// always shown in euros there.

export interface InsightsInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    filters: Filters;
    dropPct: number;
    spikePct: number;
    eurUsdRate?: number;
}

export interface AnomalyFlag {
    area: Group;
    name: string;
    severity: 'warning' | 'info';
    message: string;
    why: string;
}

export interface Insights {
    period: CoreAnalysis['period'];
    eurUsdRate: number;
    comparison: CoreAnalysis['comparison'];
    facts: string[];
    flags: AnomalyFlag[];
    filterOptions: CoreAnalysis['filterOptions'];
}

// Python: sort_values(...).iloc[0]; the first of equal values here.
function first(rows: GroupRow[], better: (a: number, b: number) => boolean): GroupRow {
    return rows.reduce((best, row) => (better(row.change_amount, best.change_amount) ? row : best));
}

const pct1 = (value: number) => pyFixed(value, 1, false);

export function factualInsights(data: CoreAnalysis): string[] {
    const facts: string[] = [];
    const revenue = data.comparison.currentRevenue ?? 0;
    const previous = data.comparison.previousRevenue ?? 0;
    if (previous) {
        const change = (revenue - previous) / previous * 100;
        facts.push(`Revenue ${change >= 0 ? 'increased' : 'decreased'} ${pct1(Math.abs(change))}% compared with the comparison period.`);
    }
    const chatters = data.groups.chatter!;
    if (chatters.length) {
        facts.push(`${chatters[0].key} generated the highest chatter revenue at ${pyMoney(chatters[0].revenue)}.`);
        const improved = first(chatters, (a, b) => a > b);
        facts.push(`${improved.key} had the largest revenue improvement at ${pyMoney(improved.change_amount)}.`);
        const declined = first(chatters, (a, b) => a < b);
        if (declined.change_amount < 0) facts.push(`${declined.key} had the largest revenue decline at ${pyMoney(declined.change_amount)}.`);
    }
    const totals = data.chatterTotals;
    const total = totals.reduce((sum, v) => sum + v, 0);
    const share = (n: number) => (total ? totals.slice(0, n).reduce((sum, v) => sum + v, 0) / total * 100 : null);
    // Python: no concentration when the period has no rows at all.
    if (data.comparison.currentRevenue !== null) {
        const top5 = share(5);
        const top8 = share(8);
        if (top5 !== null) facts.push(`Top 5 chatters generated ${pct1(top5)}% of selected-period chatter revenue.`);
        if (top8 !== null && top8 > 70) facts.push('Revenue remains heavily concentrated in the strongest chatter group.');
    }
    const creators = data.groups.creator!;
    if (creators.length) {
        const top = creators[0];
        facts.push(`${top.key} accounts for ${top.revenue_share_pct === null ? 'nan' : pct1(top.revenue_share_pct)}% of selected-period creator revenue.`);
    }
    return facts;
}

export function anomalies(data: CoreAnalysis, dropPct: number, spikePct: number): AnomalyFlag[] {
    const flags: AnomalyFlag[] = [];
    for (const area of ['chatter', 'creator', 'platform'] as const) {
        for (const row of data.groups[area]!) {
            const change = row.change_pct;
            if (change === null) continue;
            const why = `Current ${pyMoney(row.revenue)} vs previous ${pyMoney(row.previous_revenue)}.`;
            if (change <= -dropPct) {
                flags.push({area, name: row.key, severity: 'warning', message: `Revenue is ${pct1(Math.abs(change))}% below the comparison period.`, why});
            }
            if (change >= spikePct) {
                flags.push({area, name: row.key, severity: 'info', message: `Revenue is ${pct1(change)}% above the comparison period.`, why});
            }
        }
    }
    return flags;
}

export async function insights(pool: pg.Pool, input: InsightsInput): Promise<Insights> {
    const data = await coreAnalysis(pool, {...input, groups: ['chatter', 'creator', 'platform']});
    return {
        period: data.period,
        eurUsdRate: data.eurUsdRate,
        comparison: data.comparison,
        facts: factualInsights(data),
        flags: anomalies(data, input.dropPct, input.spikePct),
        filterOptions: data.filterOptions,
    };
}
