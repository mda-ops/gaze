// Date range presets of the filter bar (Python app: analytics.date_range_for).

export const DATE_RANGE_LABELS = ['Today', 'Yesterday', 'This week', 'Last week', 'Last 7 days', 'Last 30 days', 'This month', 'Last month', 'Custom'] as const;

export const COMPARE_LABELS = ['Previous period', 'Previous week', 'Previous month'] as const;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

// Monday = 0 ... Sunday = 6, like Python's date.weekday().
function weekday(date: string): number {
    return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

// "Custom" falls back to the last 30 days, as in the Python app.
export function dateRangeFor(label: string, today: string, weekStart = 'Friday'): [string, string] {
    const startIndex = Math.max(0, WEEKDAYS.indexOf(weekStart));
    const thisWeekStart = addDays(today, -((weekday(today) - startIndex + 7) % 7));
    const firstOfMonth = `${today.slice(0, 8)}01`;
    switch (label) {
        case 'Today': return [today, today];
        case 'Yesterday': return [addDays(today, -1), addDays(today, -1)];
        case 'This week': return [thisWeekStart, today];
        case 'Last week': return [addDays(thisWeekStart, -7), addDays(thisWeekStart, -1)];
        case 'Last 7 days': return [addDays(today, -6), today];
        case 'Last 30 days': return [addDays(today, -29), today];
        case 'This month': return [firstOfMonth, today];
        case 'Last month': {
            const lastOfPrevious = addDays(firstOfMonth, -1);
            return [`${lastOfPrevious.slice(0, 8)}01`, lastOfPrevious];
        }
        default: return [addDays(today, -29), today];
    }
}
