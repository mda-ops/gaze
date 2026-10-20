import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {emptyFilters} from '../lib/filters.js';
import {canCompare, CAPTURE, captureRateFor, displayed, RANGES, refPage, round, settled} from '../test-support/reference.js';
import {executiveOverview} from './executive-overview.js';

// Compares the Executive Overview with the Python app's captured numbers.

describe.skipIf(!canCompare)('Executive Overview parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const ref = refPage(name, '/c-hub/executive-overview');
        const card = (label: string) => ref.cards.find(c => c.label === label)!;
        const result = await executiveOverview(getFlowPool(), {start, end, compare: 'Previous period', filters: emptyFilters(), today: CAPTURE, eurUsdRate: captureRateFor(name, '/c-hub/executive-overview')});
        const m = result.metrics;

        expect({
            totalRevenue: round(m.totalRevenue, 2),
            changePct: round(m.revenueChangePct, 1),
            flowManagerGross: round(m.flowManagerGross, 2),
            flowManagerNet: round(m.flowManagerNet, 2),
            revenuePerHour: round(m.revenuePerHour, 2),
            activeChatters: m.activeChatters,
            activeCreators: m.activeCreators,
            totalHours: round(m.totalHours, 1),
            inactivityHours: round(m.totalInactivityMinutes === null ? null : m.totalInactivityMinutes / 60, 1),
            medianPerChatter: round(m.medianPerChatter, 2),
            avgPerCreator: round(m.avgPerCreator, 2),
        }).toEqual({
            totalRevenue: displayed(card('Total Revenue').value),
            changePct: displayed(card('Total Revenue').note.replace('% Δ ', '').replace('%', '')),
            flowManagerGross: displayed(card('Flow Manager Gross').value),
            flowManagerNet: displayed(card('Flow Manager Net').value),
            revenuePerHour: displayed(card('Revenue / Hour').value),
            activeChatters: displayed(card('Active Chatters').value),
            activeCreators: displayed(card('Active Creators').value),
            totalHours: displayed(card('Total Hours').value),
            inactivityHours: displayed(card('Total Inactivity').value),
            medianPerChatter: displayed(card('Median / Chatter').value),
            avgPerCreator: displayed(card('Avg / Creator').value),
        });

        const refTypes = ref.tables[0].rows.map(([type, revenue, days, rows]) => [type, revenue, days, rows]);
        expect(result.revenueByType.map(r => [r.transactionType, r.revenue, r.days, r.rows]))
            .toEqual(refTypes.map(([type, revenue, days, rows]) => [type, expect.closeTo(Number(revenue), 6), Number(days), Number(rows)]));

        // Trend: only days that had settled when the reference was captured. The
        // capture day was still in progress, and Flow's miner still corrects the
        // day before (on 2026-10-15 22:12 UTC it removed a EUR 48 F2F transaction
        // of 2026-10-14, after the capture).
        expect(result.trend.previousLabel).toBe(ref.chart!.previousMonthLabel);
        for (const [mine, theirs] of [[result.trend.current, ref.chart!.trend], [result.trend.previous, ref.chart!.previousMonthTrend]] as const) {
            expect(settled(mine).map(d => [d.date, d.revenue, d.platforms.map(p => [p.platform, p.revenue])]))
                .toEqual(settled(theirs).map(d => [d.date, expect.closeTo(d.revenue, 6), d.platforms.map(p => [p.platform, expect.closeTo(p.revenue, 6)])]));
        }
    }, 120_000);
});
