import type {IsoDate} from '../period.js';
import {cleanNumber, type Value} from './frame.js';

// The date of a Looker source row (Python app: parsed_date_series). Dates
// are written like "28 Jan", "23 March", "13 Mar 2026", "1  Apr 26" or
// "2026-08-18". Without a year 2020-2030 in the text, the row's Year column
// is used, else the current year. Day-first, as the Python app parses them.

export const DATE_COLUMNS = ['Date of Evaluation', 'Date', 'Created', 'Created At'];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// dateutil month names: full name, three letters, or "sept".
function monthOf(token: string): number | null {
    const t = token.toLowerCase();
    if (t === 'sept') return 9;
    const short = MONTHS.indexOf(t);
    if (short >= 0) return short + 1;
    const full = MONTH_NAMES.indexOf(t);
    return full >= 0 ? full + 1 : null;
}

function valid(year: number, month: number, day: number): IsoDate | null {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseLookerDate(raw: Value | undefined, yearValue: Value | undefined, currentYear: number): IsoDate | null {
    let text = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!text || ['nan', 'none'].includes(text.toLowerCase())) return null;
    if (!/\d/.test(text)) return null;
    let hasYear = false;
    for (let y = 2020; y <= 2030; y++) if (text.includes(String(y))) hasYear = true;
    if (!hasYear) {
        const year = yearValue !== undefined && cleanNumber(yearValue) ? Math.trunc(cleanNumber(yearValue)) : currentYear;
        text = `${text} ${year}`;
    }
    const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
    if (iso) return valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));

    const tokens = text.split(/[\s,./-]+/).filter(Boolean);
    let month: number | null = null;
    const numbers: string[] = [];
    for (const token of tokens) {
        const m = monthOf(token);
        if (m !== null && month === null) month = m;
        else if (/^\d+$/.test(token)) numbers.push(token);
        else return null;
    }
    // Two-digit years are 20xx (dateutil: the century closest to now).
    const yearOf = (n: string) => (n.length <= 2 ? 2000 + Number(n) : Number(n));
    if (month !== null) {
        // Day, then year: in "1 Apr 25 2026" dateutil takes 25 as the year and
        // the appended 2026 as a time (20:26).
        if (numbers.length < 2) return null;
        return numbers[0].length === 4 ? valid(Number(numbers[0]), month, Number(numbers[1])) : valid(yearOf(numbers[1]), month, Number(numbers[0]));
    }
    // All numbers, day first: d/m/yyyy or yyyy/m/d; "12 2026" is December 2026.
    const yearIndex = numbers.findIndex(n => n.length === 4);
    if (yearIndex < 0) return null;
    const year = Number(numbers[yearIndex]);
    const rest = numbers.filter((_, i) => i !== yearIndex).map(Number);
    if (rest.length === 1) return valid(year, rest[0], 1);
    if (rest.length < 2) return null;
    return yearIndex === 0 ? valid(year, rest[0], rest[1]) : valid(year, rest[1], rest[0]);
}
