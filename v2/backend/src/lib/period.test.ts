import {describe, expect, it} from 'vitest';
import {comparisonRange, eachDay, isIsoDate, previousMonthSameDays, shortRangeLabel, todayIn} from './period.js';

describe('period helpers (match the Python app)', () => {
    it('validates ISO dates', () => {
        expect(isIsoDate('2026-09-30')).toBe(true);
        expect(isIsoDate('2026-02-30')).toBe(false);
        expect(isIsoDate('30-09-2026')).toBe(false);
    });

    it('computes comparison ranges', () => {
        expect(comparisonRange('2026-09-01', '2026-09-30', 'Previous period')).toEqual(['2026-08-02', '2026-08-31']);
        expect(comparisonRange('2026-10-01', '2026-10-01', 'Previous period')).toEqual(['2026-09-30', '2026-09-30']);
        expect(comparisonRange('2026-10-02', '2026-10-08', 'Previous week')).toEqual(['2026-09-25', '2026-10-01']);
        expect(comparisonRange('2026-10-02', '2026-10-08', 'Previous month')).toEqual(['2026-09-02', '2026-09-08']);
    });

    it('computes previous month same days, capped at month end', () => {
        expect(previousMonthSameDays('2026-10-01', '2026-10-15')).toEqual(['2026-09-01', '2026-09-15']);
        expect(previousMonthSameDays('2026-03-01', '2026-03-31')).toEqual(['2026-02-01', '2026-02-28']);
    });

    it('lists days and labels ranges', () => {
        expect(eachDay('2026-09-29', '2026-10-01')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
        expect(shortRangeLabel('2026-09-01', '2026-09-15')).toBe('Sep 1 - Sep 15');
    });

    it('gives the business date in a time zone', () => {
        const lateUtc = new Date('2026-10-15T22:30:00Z');
        expect(todayIn('Europe/Amsterdam', lateUtc)).toBe('2026-10-16');
        expect(todayIn('UTC', lateUtc)).toBe('2026-10-15');
    });
});
