import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {canCompare, CAPTURE, captureRateFor, displayed, RANGES, refPage, round, settled} from '../test-support/reference.js';
import {modelRevenue} from './model-revenue.js';

// Model Revenue Overview against the Python app's captured page.
// Not compared: current subscriber counts (live in Flow, they change daily),
// and the Python app's "nan" badges (a display bug v2 does not reproduce).

const noFilters = {creator: [], platform: [], agency: [], team: [], transaction_type: []};

describe.skipIf(!canCompare)('Model Revenue parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const ref = refPage(name, '/c-hub/revenue');
        const result = await modelRevenue(getFlowPool(), {
            start, end, compare: 'Previous period', filters: noFilters, sort: 'revenue', direction: 'desc',
            today: CAPTURE, eurUsdRate: captureRateFor(name, '/c-hub/revenue'),
        });

        expect(result.platformTotals.map(t => [t.platform, round(t.revenue, 2), round(t.share, 1)]))
            .toEqual(ref.platform_totals!.map(t => [t.platform, displayed(t.amount), displayed(t.share)]));

        expect(result.cards.map(c => ({
            model: c.model,
            total: round(c.total, 2),
            subscriptions: c.subscriptionRevenue ? round(c.subscriptionRevenue, 2) : null,
            badges: [c.agencies.join(' / '), c.tiers.join(' / ')].filter(Boolean),
            platforms: c.platforms.map(p => [p.platform, round(p.revenue, 2)]),
        }))).toEqual(ref.revenue_cards!.map(c => ({
            model: c.name,
            total: displayed(c.total),
            subscriptions: c.subscriptions ? displayed(c.subscriptions) : null,
            badges: c.badges.map(b => b.split(' / ').filter(part => part !== 'nan').join(' / ')).filter(Boolean),
            platforms: c.platforms.map(p => [p.platform, displayed(p.amount)]),
        })));

        const options = (field: string) => ref.selects![field].filter(v => v !== 'All');
        expect(result.filterOptions.creator).toEqual(options('model_creator'));
        expect(result.filterOptions.agency).toEqual(options('model_agency'));
        expect(result.filterOptions.team).toEqual(options('model_team'));

        expect(result.trend.previousLabel).toBe(ref.chart!.previousMonthLabel);
        for (const [mine, theirs] of [[result.trend.current, ref.chart!.trend], [result.trend.previous, ref.chart!.previousMonthTrend]] as const) {
            expect(settled(mine).map(d => [d.date, d.revenue]))
                .toEqual(settled(theirs).map(d => [d.date, expect.closeTo(d.revenue, 6)]));
        }
    }, 120_000);
});
