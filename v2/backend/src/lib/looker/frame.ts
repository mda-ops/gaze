// A CSV file read the way the Python app's pandas.read_csv() reads it: the
// same column names, missing values and column types. Only what the Looker
// pages need.

export type Value = string | number | boolean | null;
export type ColumnType = 'int' | 'float' | 'bool' | 'str';

export interface Frame {
    columns: string[];
    types: Record<string, ColumnType>;
    rows: Record<string, Value>[];
}

// pandas' default na_values.
const NA = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA',
    'NULL', 'NaN', 'None', 'n/a', 'nan', 'null']);
const INT = /^\s*[+-]?\d+\s*$/;
const FLOAT = /^\s*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|inf|infinity)\s*$/i;
const TRUE = new Set(['True', 'TRUE', 'true']);
const FALSE = new Set(['False', 'FALSE', 'false']);

// RFC 4180 records; quoted fields keep their line breaks.
function records(text: string): string[][] {
    const out: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    let touched = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
            } else field += c;
            continue;
        }
        if (c === '"') { quoted = true; touched = true; }
        else if (c === ',') { row.push(field); field = ''; touched = true; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            // pandas skips lines that are completely empty.
            if (touched || row.length > 1 || row[0] !== '') out.push(row);
            row = []; field = ''; touched = false;
        } else { field += c; touched = true; }
    }
    if (touched || field !== '' || row.length) {
        row.push(field);
        if (row.length > 1 || row[0] !== '') out.push(row);
    }
    return out;
}

// pandas header rules: blank names become "Unnamed: <i>", repeats get ".1", ".2".
function headerNames(raw: string[]): string[] {
    const seen = new Map<string, number>();
    return raw.map((name, i) => {
        let base = name === '' ? `Unnamed: ${i}` : name;
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        if (count) {
            let candidate = `${base}.${count}`;
            while (seen.has(candidate)) candidate = `${base}.${seen.get(base)!}`;
            seen.set(candidate, 1);
            base = candidate;
        }
        return base;
    });
}

function columnType(cells: (string | null)[]): ColumnType {
    const present = cells.filter((c): c is string => c !== null);
    if (!present.length) return 'float';
    if (present.every(c => INT.test(c))) return present.length === cells.length ? 'int' : 'float';
    if (present.every(c => FLOAT.test(c) || INT.test(c))) return 'float';
    if (present.length === cells.length && present.every(c => TRUE.has(c) || FALSE.has(c))) return 'bool';
    return 'str';
}

function convert(cell: string | null, type: ColumnType): Value {
    if (cell === null) return null;
    if (type === 'int' || type === 'float') {
        const text = cell.trim().toLowerCase().replace(/^([+-]?)infinity$/, '$1inf');
        if (text === 'inf' || text === '+inf') return Infinity;
        if (text === '-inf') return -Infinity;
        return Number(text);
    }
    if (type === 'bool') return TRUE.has(cell);
    return cell;
}

export function readCsv(text: string): Frame {
    const all = records(text.replace(/^﻿/, ''));
    if (!all.length) return {columns: [], types: {}, rows: []};
    const columns = headerNames(all[0]);
    const body = all.slice(1).map(r => columns.map((_, i) => {
        const cell = r[i] ?? '';
        return NA.has(cell) ? null : cell;
    }));
    const types: Record<string, ColumnType> = {};
    columns.forEach((name, i) => { types[name] = columnType(body.map(r => r[i])); });
    const rows = body.map(r => Object.fromEntries(columns.map((name, i) => [name, convert(r[i], types[name])])));
    return {columns, types, rows};
}

export const emptyFrame = (): Frame => ({columns: [], types: {}, rows: []});

// Python app: clean_number. A cell as a number; anything unreadable is 0.
export function cleanNumber(value: Value | undefined): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isNaN(value) ? 0 : value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const text = value.trim();
    if (!text || ['nan', 'none', 'warmup'].includes(text.toLowerCase())) return 0;
    const stripped = text.replace(/\$/g, '').replace(/EUR/g, '').replace(/,/g, '').replace(/%/g, '').trim();
    return pyFloat(stripped) ?? 0;
}

// Python's float() on text, or null when it raises.
export function pyFloat(text: string): number | null {
    const t = text.trim().replace(/_(?=\d)/g, '');
    if (/^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/.test(t)) return Number(t);
    const lower = t.toLowerCase();
    if (/^[+-]?(inf|infinity)$/.test(lower)) return lower.startsWith('-') ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(lower)) return NaN;
    return null;
}
