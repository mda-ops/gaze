import {describe, expect, it} from 'vitest';
import type {TeamBonusRule} from '../queries/finance-inputs.js';
import {flowBonuses} from './commissions.js';

// Flow's English day-level bonus (flat_day_threshold), as described in Flow's
// docs/reference/chatter-commission.md. Amounts are EUR; thresholds are USD.
const rate = 1.25;
const english: TeamBonusRule = {
    team: 'English',
    type: 'flat_day_threshold',
    config: {tiers: [{thresholdUsd: 1000, rate: 0.01}, {thresholdUsd: 2000, rate: 0.02}]},
};

const row = (date: string, chatter: string, net: number) =>
    ({date, team: 'English', chatter, creator_id: 'c1', platform: 'OF', revenue: net, net});

describe('flowBonuses: flat_day_threshold', () => {
    it('pays the highest cleared tier on the whole day, summed over accounts', () => {
        // Day 1: 900 + 700 = 1,600 EUR = 2,000 USD -> 2%. Day 2: 1,000 EUR = 1,250 USD -> 1%.
        const rows = [row('2026-10-01', 'Kim', 900), {...row('2026-10-01', 'Kim', 700), creator_id: 'c2'}, row('2026-10-02', 'Kim', 1000)];
        const bonuses = flowBonuses(rows, [english], [], rate, false);
        expect(bonuses.get('English\u0000Kim')).toBeCloseTo(1600 * 0.02 + 1000 * 0.01, 9);
    });

    it('pays nothing on a day that clears no tier', () => {
        const bonuses = flowBonuses([row('2026-10-01', 'Kim', 799)], [english], [], rate, false);
        expect(bonuses.get('English\u0000Kim')).toBeUndefined();
    });

    it('never pays in legacy (Python app) mode', () => {
        const bonuses = flowBonuses([row('2026-10-01', 'Kim', 5000)], [english], [], rate, true);
        expect(bonuses.size).toBe(0);
    });
});
