import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {canCompare, captureRateFor, displayed, RANGES, refPage, round} from '../test-support/reference.js';
import {chatterRevenue} from './chatter-revenue.js';

// Chatter Revenue Overview against the Python app's captured page.

const noFilters = {chatter: [], platform: [], team: [], creator: [], transaction_type: []};

describe.skipIf(!canCompare)('Chatter Revenue parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const ref = refPage(name, '/c-hub/chatter-revenue');
        const card = (label: string) => ref.cards.find(c => c.label === label)!;
        const result = await chatterRevenue(getFlowPool(), {
            start, end, compare: 'Previous period', filters: noFilters, sort: 'revenue', direction: 'desc', eurUsdRate: captureRateFor(name, '/c-hub/chatter-revenue'),
        });
        const m = result.metrics;

        expect({
            totalRevenue: round(m.totalRevenue, 2),
            changePct: round(m.revenueChangePct, 1),
            activeChatters: m.activeChatters,
            avgPerChatter: round(m.avgPerChatter, 2),
            revenuePerHour: round(m.revenuePerHour, 2),
            totalHours: round(m.totalHours, 1),
        }).toEqual({
            totalRevenue: displayed(card('Total Revenue').value),
            changePct: displayed(card('Total Revenue').note.replace('% Δ ', '')),
            activeChatters: displayed(card('Active Chatters').value),
            avgPerChatter: displayed(card('Avg / Chatter').value),
            revenuePerHour: displayed(card('Revenue / Hour').value),
            totalHours: displayed(card('Total Hours').value),
        });

        expect(result.platformTotals.map(t => [t.platform, round(t.revenue, 2), round(t.share, 1)]))
            .toEqual(ref.platform_totals!.map(t => [t.platform, displayed(t.amount), displayed(t.share)]));

        expect(result.cards.map(c => ({
            chatter: c.chatter,
            total: round(c.total, 2),
            perHour: c.revenuePerHour === null ? null : round(c.revenuePerHour, 2),
            platforms: c.platforms.map(p => [p.platform, round(p.revenue, 2)]),
        }))).toEqual(ref.revenue_cards!.map(c => ({
            chatter: c.name,
            total: displayed(c.total),
            perHour: c.head ? displayed(c.head) : null,
            platforms: c.platforms.map(p => [p.platform, displayed(p.amount)]),
        })));

        const options = (field: string) => ref.selects![field].filter(v => v !== 'All');
        expect(result.filterOptions.chatter).toEqual(options('chatter_name'));
        expect(result.filterOptions.team).toEqual(options('chatter_team'));
        expect(result.filterOptions.creator).toEqual(options('chatter_creator'));
    }, 120_000);
});
