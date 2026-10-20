import {describe, expect, it} from 'vitest';
import {hourSegments, matchEpisodesToShifts, median, priceEpisodes, quantile, tierMaps, type EpisodeInput, type ShiftInput} from './inactivity-cost.js';

// Epoch microseconds.
const T = (iso: string) => Date.parse(iso) * 1000;

describe('statistics (same as pandas)', () => {
    it('median and linear quantile', () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
        expect(quantile([10, 20, 30, 40, 50], 0.9)).toBe(46);
    });
});

describe('hourSegments', () => {
    it('splits at whole hours and labels Sarajevo hours (CEST = UTC+2)', () => {
        expect(hourSegments(T('2026-09-01T10:30:00Z'), T('2026-09-01T12:15:00Z')))
            .toEqual([[12, 0.5], [13, 1], [14, 0.25]]);
        expect(hourSegments(T('2026-09-01T10:00:00Z'), null)).toEqual([]);
    });
});

describe('tierMaps', () => {
    it('normalises tiers and lets the last account (lowest tier) win', () => {
        const maps = tierMaps([
            {creatorId: '1', creator: 'Jane', tier: 'A'},
            {creatorId: '1', creator: 'Jane', tier: 'tier c'},
            {creatorId: '2', creator: 'Emma', tier: ''},
        ]);
        expect(maps.byId.get('1')).toBe('C');
        expect(maps.byName.get('jane')).toBe('C');
        expect(maps.byId.has('2')).toBe(false);
    });
});

const shift = (over: Partial<ShiftInput>): ShiftInput => ({
    creatorId: '1', creator: 'Jane', chatterId: '7', chatter: 'Eren',
    startUs: T('2026-09-01T08:00:00Z'), endUs: T('2026-09-01T16:00:00Z'), shiftHours: 8, ...over,
});
const episode = (over: Partial<EpisodeInput>): EpisodeInput => ({
    key: 'inactivity|1|7', creatorId: '1', creator: 'Jane', chatterId: '7', chatter: 'Eren',
    startUs: T('2026-09-01T09:00:00Z'), endUs: T('2026-09-01T10:00:00Z'), inactiveMinutes: 60, peakUnread: 3, platform: 'F2F', team: 'Dutch', ...over,
});

describe('matchEpisodesToShifts', () => {
    it('keeps only episodes overlapping a shift of the same chatter, capped at the overlap', () => {
        const matched = matchEpisodesToShifts([
            episode({}),
            episode({startUs: T('2026-09-01T15:30:00Z'), endUs: T('2026-09-01T17:00:00Z'), inactiveMinutes: 90}),
            episode({chatterId: '8'}),
        ], [shift({})]);
        expect(matched.map(m => m.scheduledMinutes)).toEqual([60, 30]);
    });
});

describe('priceEpisodes', () => {
    it("prices with the model's own revenue for that hour, uncapped", () => {
        const matched = matchEpisodesToShifts([episode({})], [shift({})]);
        // EUR 800 of tips/messages in Sarajevo hour 11 (09:00 UTC), one worked hour then -> EUR 800/h.
        const priced = priceEpisodes(matched, [shift({})], [{creatorId: '1', creatorKey: 'jane', localHour: 11, revenue: 800}],
            tierMaps([{creatorId: '1', creator: 'Jane', tier: 'A'}]));
        expect(priced[0].moneyWasted).toBeCloseTo(800, 6);
        expect(priced[0].creatorTier).toBe('A');
    });
});
