import type pg from 'pg';
import type {Filters} from '../lib/filters.js';
import type {IsoDate} from '../lib/period.js';
import {coreAnalysis, type CoreAnalysis, type GroupRow} from './core-analysis.js';

// /ask (Python app: ask). Picks the chatter that answers one of three fixed
// questions; the page words the answer in the display currency.

export interface AskInput {
    start: IsoDate;
    end: IsoDate;
    compare: string;
    filters: Filters;
    question: string;
    eurUsdRate?: number;
}

export type AskAnswer =
    | {kind: 'none'}
    | {kind: 'improved'; chatter: string; changeAmount: number}
    | {kind: 'highHours'; chatter: string; hours: number; revenuePerHour: number | null}
    | {kind: 'bestRate'; chatter: string; revenuePerHour: number | null};

export interface Ask {
    period: CoreAnalysis['period'];
    eurUsdRate: number;
    comparison: CoreAnalysis['comparison'];
    question: string;
    answer: AskAnswer;
    filterOptions: CoreAnalysis['filterOptions'];
}

// Python sort_values: missing values go last whatever the direction.
function byValue(a: number | null, b: number | null, direction: 1 | -1): number {
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return (a - b) * direction;
}

export function askAnswer(question: string, chatters: GroupRow[]): AskAnswer {
    const q = question.toLowerCase();
    if (!chatters.length) return {kind: 'none'};
    if (q.includes('improved')) {
        const row = [...chatters].sort((a, b) => b.change_amount - a.change_amount)[0];
        return {kind: 'improved', chatter: row.key, changeAmount: row.change_amount};
    }
    if (q.includes('high hours')) {
        // Most hours; among equal hours, the lowest revenue per hour.
        const row = [...chatters].sort((a, b) => b.hours - a.hours || byValue(a.revenue_per_hour, b.revenue_per_hour, 1))[0];
        return {kind: 'highHours', chatter: row.key, hours: row.hours, revenuePerHour: row.revenue_per_hour};
    }
    if (q.includes('highest revenue per hour')) {
        const row = [...chatters].sort((a, b) => byValue(a.revenue_per_hour, b.revenue_per_hour, -1))[0];
        return {kind: 'bestRate', chatter: row.key, revenuePerHour: row.revenue_per_hour};
    }
    return {kind: 'none'};
}

export async function ask(pool: pg.Pool, input: AskInput): Promise<Ask> {
    const data = await coreAnalysis(pool, {...input, groups: ['chatter']});
    return {
        period: data.period,
        eurUsdRate: data.eurUsdRate,
        comparison: data.comparison,
        question: input.question,
        answer: askAnswer(input.question, data.groups.chatter!),
        filterOptions: data.filterOptions,
    };
}
