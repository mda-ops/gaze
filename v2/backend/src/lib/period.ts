// Business-date helpers. Dates are 'YYYY-MM-DD' strings; arithmetic is done in
// UTC so time zones and DST never shift a day.

export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is IsoDate {
    return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

function toDate(value: IsoDate): Date {
    return new Date(`${value}T00:00:00Z`);
}

function fromDate(value: Date): IsoDate {
    return value.toISOString().slice(0, 10);
}

export function addDays(value: IsoDate, days: number): IsoDate {
    const d = toDate(value);
    d.setUTCDate(d.getUTCDate() + days);
    return fromDate(d);
}

export function daysBetweenInclusive(start: IsoDate, end: IsoDate): number {
    return Math.round((toDate(end).getTime() - toDate(start).getTime()) / 86_400_000) + 1;
}

export function eachDay(start: IsoDate, end: IsoDate): IsoDate[] {
    const days: IsoDate[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
    return days;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
    return a < b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
    return a > b ? a : b;
}

export const COMPARE_MODES = ['Previous period', 'Previous week', 'Previous month'] as const;

// Python app: analytics.comparison_range. "Previous month" is 30 days back,
// not a calendar month.
export function comparisonRange(start: IsoDate, end: IsoDate, mode: string): [IsoDate, IsoDate] {
    if (mode === 'Previous week') return [addDays(start, -7), addDays(end, -7)];
    if (mode === 'Previous month') return [addDays(start, -30), addDays(end, -30)];
    const days = daysBetweenInclusive(start, end);
    return [addDays(start, -days), addDays(start, -1)];
}

// Python app: web.previous_month_same_days. Day 1 to the same day number of the
// previous calendar month, capped at that month's last day.
export function previousMonthSameDays(start: IsoDate, end: IsoDate): [IsoDate, IsoDate] {
    const lastOfPrevious = addDays(start, -1);
    const previousStart = `${lastOfPrevious.slice(0, 8)}01`;
    const endDay = Math.min(Number(end.slice(8, 10)), Number(lastOfPrevious.slice(8, 10)));
    return [previousStart, `${lastOfPrevious.slice(0, 8)}${String(endDay).padStart(2, '0')}`];
}

// Today's date in a time zone (Python app: business_today, settings "timezone").
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
    try {
        return new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
    } catch {
        return fromDate(now);
    }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Sep 1 - Sep 15" (Python: f"{d:%b} {d.day} - {e:%b} {e.day}").
export function shortRangeLabel(start: IsoDate, end: IsoDate): string {
    const part = (d: IsoDate) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
    return `${part(start)} - ${part(end)}`;
}
