import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {emptyFilters} from '../lib/filters.js';
import {canCompare, captureRateFor, displayed, RANGES, refPage, round} from '../test-support/reference.js';
import {inactivity} from './inactivity.js';

// Inactivity against the Python app's captured page: cards (with their
// comparison notes), the per-chatter table and the tier table.

function compareNote(current: number, previous: number): string {
    if (!previous) return 'no previous data';
    const change = (current - previous) / previous * 100;
    return `${change > 0 ? '+' : ''}${change.toFixed(1)}% vs previous`;
}

const hours = (value: number) => `${value.toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1})}h`;

describe.skipIf(!canCompare)('Inactivity parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const ref = refPage(name, '/c-hub/inactivity');
        const card = (label: string) => ref.cards.find(c => c.label === label)!;
        const r = await inactivity(getFlowPool(), {start, end, compare: 'Previous period', filters: emptyFilters(), eurUsdRate: captureRateFor(name, '/c-hub/inactivity')});

        expect({
            events: r.current.events,
            eventsNote: compareNote(r.current.events, r.previous.events),
            peak: r.current.peakUnread,
            peakNote: compareNote(r.current.peakUnread, r.previous.peakUnread),
            hours: round(r.current.totalHours, 1),
            hoursNote: compareNote(r.current.totalHours, r.previous.totalHours),
            money: round(r.current.moneyWasted, 2),
            moneyNote: compareNote(r.current.moneyWasted, r.previous.moneyWasted),
            worst: r.current.worstChatter,
            worstMoney: round(r.current.worstMoney, 2),
        }).toEqual({
            events: displayed(card('Events').value),
            eventsNote: card('Events').note,
            peak: displayed(card('Peak Unread').value),
            peakNote: card('Peak Unread').note,
            hours: displayed(card('Total Hours').value),
            hoursNote: card('Total Hours').note,
            money: displayed(card('Money Wasted').value),
            moneyNote: card('Money Wasted').note,
            worst: card('Highest Risk').value,
            worstMoney: displayed(card('Highest Risk').note),
        });

        const [tierTable, chatterTable] = ref.tables;
        expect(r.tiers.map(t => [t.creatorTier, t.events, t.models, hours(t.scheduledHours), t.moneyWasted, hours(t.shiftHours), `${t.inactivityPct.toFixed(1)}%`, t.avgCostPerHour]))
            .toEqual(tierTable.rows.map(row => [row[0], row[1], row[2], row[3], expect.closeTo(Number(row[4]), 6), row[5], row[6], expect.closeTo(Number(row[7]), 6)]));
        expect(r.chatters.map(c => [c.chatter, c.events, c.creators, c.platforms, c.peakUnread, hours(c.totalHours), hours(c.maxHours), c.moneyWasted, c.avgCostPerHour]))
            .toEqual(chatterTable.rows.map(row => [row[0], row[1], row[2], row[3], row[4], row[5], row[6], expect.closeTo(Number(row[7]), 6), expect.closeTo(Number(row[8]), 6)]));
    }, 180_000);
});
