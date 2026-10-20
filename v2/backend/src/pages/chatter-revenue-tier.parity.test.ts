import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {canCompare, CAPTURE, captureRateFor, pyMoney, RANGES, refPage} from '../test-support/reference.js';
import {chatterRevenueTier} from './chatter-revenue-tier.js';

// Chatting Revenue Tier against the Python app's captured matrix. The matrix
// covers all completed months whatever the selected range, so each capture is
// compared at its own EUR/USD rate.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ARROWS: Record<string, string> = {up: '↑', down: '↓', same: '→', '': ''};

describe.skipIf(!canCompare)('Chatting Revenue Tier parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async name => {
        const ref = refPage(name, '/c-hub/chatter-revenue-tier');
        const r = await chatterRevenueTier(getFlowPool(), {today: CAPTURE, eurUsdRate: captureRateFor(name, '/c-hub/chatter-revenue-tier')});

        expect(r.months.map(m => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`)).toEqual(ref.tier_matrix!.months);
        expect(r.rows.map(row => [row.model, row.cells.map(c => [c.tier, ARROWS[c.arrow], pyMoney(c.revenue)])])).toEqual(ref.tier_matrix!.rows);
        const card = (label: string) => ref.cards.find(c => c.label === label)!.value;
        expect([String(r.months.length), String(r.latestCounts.A), String(r.latestCounts.B), String(r.latestCounts.C)])
            .toEqual([card('Months'), card('Tier A'), card('Tier B'), card('Tier C')]);
    }, 120_000);
});
