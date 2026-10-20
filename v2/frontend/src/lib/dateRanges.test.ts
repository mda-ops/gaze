import {describe, expect, it} from 'vitest';
import {dateRangeFor} from './dateRanges';

describe('dateRangeFor (Friday week start, like the Python app)', () => {
    // 2026-10-15 is a Thursday: the reporting week started Friday 2026-10-09.
    const today = '2026-10-15';

    it('computes week ranges from the reporting week start', () => {
        expect(dateRangeFor('This week', today)).toEqual(['2026-10-09', '2026-10-15']);
        expect(dateRangeFor('Last week', today)).toEqual(['2026-10-02', '2026-10-08']);
        expect(dateRangeFor('This week', '2026-10-16')).toEqual(['2026-10-16', '2026-10-16']);
    });

    it('computes the other presets', () => {
        expect(dateRangeFor('Today', today)).toEqual([today, today]);
        expect(dateRangeFor('Yesterday', today)).toEqual(['2026-10-14', '2026-10-14']);
        expect(dateRangeFor('Last 7 days', today)).toEqual(['2026-10-09', today]);
        expect(dateRangeFor('This month', today)).toEqual(['2026-10-01', today]);
        expect(dateRangeFor('Last month', today)).toEqual(['2026-09-01', '2026-09-30']);
        expect(dateRangeFor('Custom', today)).toEqual(['2026-09-16', today]);
    });
});
