import {useMemo, useState, type ReactNode} from 'react';

// A data table with search, column filters and sorting (Python app:
// table_html + app.js enhanceDataTable). Sorting uses each cell's raw value,
// so money and percentages sort as numbers.

export interface Column<Row> {
    label: string;
    // Raw value: used for sorting and filtering.
    value: (row: Row) => string | number | null;
    // Displayed text; defaults to the raw value.
    render?: (row: Row) => ReactNode;
    // Text used for search and the column filter; defaults to the raw value.
    text?: (row: Row) => string;
}

// Columns worth a filter dropdown (same rule as the Python app).
const FILTERABLE = ['creator', 'model', 'chatter', 'tier', 'platform', 'team', 'status', 'transaction type', 'type', 'source', 'last updated', 'updated at', 'date'];

function cellText<Row>(column: Column<Row>, row: Row): string {
    if (column.text) return column.text(row);
    const value = column.value(row);
    return value === null ? '' : String(value);
}

function compare(a: string | number | null, b: string | number | null): number {
    // Missing values are unknown, not zero: they stay last in both directions.
    if (a === null || a === '') return b === null || b === '' ? 0 : 1;
    if (b === null || b === '') return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'});
}

export function DataTable<Row>({columns, rows}: {columns: Column<Row>[]; rows: Row[]}) {
    const [search, setSearch] = useState('');
    const [filters, setFilters] = useState<Record<number, string>>({});
    const [sort, setSort] = useState<{index: number; direction: 'asc' | 'desc'} | null>(null);

    const filterColumns = useMemo(() => columns.map((column, index) => {
        const label = column.label.toLowerCase();
        if (!FILTERABLE.some(part => label.includes(part))) return null;
        const values = [...new Set(rows.map(r => cellText(column, r)).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}));
        return values.length > 1 && values.length <= 100 ? {index, values} : null;
    }).filter((f): f is {index: number; values: string[]} => f !== null), [columns, rows]);

    const visible = useMemo(() => {
        const term = search.trim().toLowerCase();
        let result = rows.filter(row => {
            if (term && !columns.map(c => cellText(c, row)).join(' ').toLowerCase().includes(term)) return false;
            return Object.entries(filters).every(([index, value]) => !value || cellText(columns[Number(index)], row) === value);
        });
        if (sort) {
            const column = columns[sort.index];
            result = [...result].sort((a, b) => {
                const va = column.value(a);
                const vb = column.value(b);
                const missing = va === null || va === '' || vb === null || vb === '';
                const order = compare(va, vb);
                return sort.direction === 'desc' && !missing ? -order : order;
            });
        }
        return result;
    }, [rows, columns, search, filters, sort]);

    if (!rows.length) return <div className="empty">No rows for the selected filters.</div>;

    function toggleSort(index: number) {
        setSort(current => {
            if (!current || current.index !== index) return {index, direction: 'asc'};
            if (current.direction === 'asc') return {index, direction: 'desc'};
            return null;
        });
    }

    return (
        <>
            <div className="table-tools">
                <input type="search" className="table-search" placeholder="Search table" aria-label="Search table" value={search} onChange={e => setSearch(e.target.value)}/>
                {filterColumns.map(({index, values}) => (
                    <select key={index} className="table-filter" aria-label={`Filter by ${columns[index].label}`} value={filters[index] ?? ''}
                            onChange={e => setFilters(f => ({...f, [index]: e.target.value}))}>
                        <option value="">All {columns[index].label}</option>
                        {values.map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                ))}
            </div>
            <table className="data-table">
                <thead>
                    <tr>
                        {columns.map((column, index) => (
                            <th key={column.label} data-sort={sort?.index === index ? sort.direction : undefined}>
                                <button type="button" className="table-sort" aria-label={`Sort by ${column.label}`} onClick={() => toggleSort(index)}>{column.label}</button>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {visible.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                            {columns.map(column => <td key={column.label}>{column.render ? column.render(row) : cellText(column, row)}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </>
    );
}
