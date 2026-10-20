import {useMemo} from 'react';
import {useSearchParams} from 'react-router-dom';
import {useConfig} from '../api/config';
import {dateRangeFor} from './dateRanges';
import type {Currency} from './format';

// The filter state of a page lives in the URL, like the Python app's GET form:
// ?range=This+month&start=...&end=...&compare=...&currency=EUR&platform=OF&platform=F2F

export const FILTER_FIELDS = ['platform', 'team', 'creator', 'chatter', 'transaction_type'] as const;
export type FilterField = typeof FILTER_FIELDS[number];

export interface PageQuery {
    range: string;
    start: string;
    end: string;
    compare: string;
    currency: Currency;
    filters: Record<FilterField, string[]>;
}

// `customDefault` gives the dates when the default range is "Custom" and the
// URL has none (e.g. Target Monitoring: the last 14 days).
export function usePageQuery(defaultRange = 'Today', customDefault?: (today: string) => [string, string]): [PageQuery | null, (next: PageQuery) => void] {
    const [params, setParams] = useSearchParams();
    const config = useConfig();

    const query = useMemo<PageQuery | null>(() => {
        if (!config.data) return null;
        const range = params.get('range') ?? defaultRange;
        const [presetStart, presetEnd] = range === 'Custom' && customDefault
            ? customDefault(config.data.today)
            : dateRangeFor(range, config.data.today, config.data.reportingWeekStart);
        const filters = Object.fromEntries(FILTER_FIELDS.map(f => [f, params.getAll(f).filter(Boolean)])) as PageQuery['filters'];
        const currency = (params.get('currency') ?? config.data.defaultCurrency) === 'USD' ? 'USD' : 'EUR';
        return {
            range,
            start: params.get('start') || presetStart,
            end: params.get('end') || presetEnd,
            compare: params.get('compare') ?? 'Previous period',
            currency,
            filters,
        };
    }, [params, config.data, defaultRange, customDefault]);

    function update(next: PageQuery) {
        const search = new URLSearchParams({range: next.range, start: next.start, end: next.end, compare: next.compare, currency: next.currency});
        for (const field of FILTER_FIELDS) for (const value of next.filters[field]) search.append(field, value);
        setParams(search);
    }

    return [query, update];
}

// The API query string for a page's data.
export function apiQueryString(query: PageQuery): string {
    const search = new URLSearchParams({start: query.start, end: query.end, compare: query.compare});
    for (const field of FILTER_FIELDS) for (const value of query.filters[field]) search.append(field, value);
    return search.toString();
}
