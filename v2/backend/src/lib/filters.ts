// The page filters (platform, team, creator, chatter, transaction type), as
// in the Python app's filter bar. Each holds the selected values; empty means
// "All". A missing value in the data counts as "Unknown", like the Python
// app's fillna("Unknown").

export const FILTER_FIELDS = ['platform', 'team', 'creator', 'chatter', 'transaction_type'] as const;
export type FilterField = typeof FILTER_FIELDS[number];
export type Filters = Record<FilterField, string[]>;

export function emptyFilters(): Filters {
    return {platform: [], team: [], creator: [], chatter: [], transaction_type: []};
}

// From a query string where each field may repeat (?platform=OF&platform=F2F).
export function parseFilters(query: Record<string, unknown>): Filters {
    const filters = emptyFilters();
    for (const field of FILTER_FIELDS) {
        const raw = query[field];
        const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
        filters[field] = values.map(String).filter(v => v !== '');
    }
    return filters;
}

// SQL condition on a row source with columns named like the fields. Appends
// one parameter per active filter to `params` and returns e.g.
// "COALESCE(platform, 'Unknown') = ANY($4) AND ...", or "TRUE" when none apply.
export function filterSql(filters: Filters, params: unknown[], fields: readonly FilterField[] = FILTER_FIELDS): string {
    const conditions: string[] = [];
    for (const field of fields) {
        if (!filters[field].length) continue;
        params.push(filters[field]);
        conditions.push(`COALESCE(${field}, 'Unknown') = ANY($${params.length}::text[])`);
    }
    return conditions.length ? conditions.join(' AND ') : 'TRUE';
}
