import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {emptyFilters} from '../lib/filters.js';
import {canCompare, captureRateFor, RANGES, refPage} from '../test-support/reference.js';
import {transactions} from './transactions.js';

// Transactions against the Python app's captured page (defaults: tips and
// messages of EUR 199 and more). Rows with equal amounts have no defined order
// in the Python app, so rows are compared as a sorted set.

function key(row: unknown[]): string {
    return JSON.stringify(row);
}

describe.skipIf(!canCompare)('Transactions parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const ref = refPage(name, '/c-hub/transactions');
        const result = await transactions(getFlowPool(), {
            start, end, compare: 'Previous period', filters: emptyFilters(), types: ['tip', 'message'], threshold: 199, eurUsdRate: captureRateFor(name, '/c-hub/transactions'),
        });

        const mine = result.rows.map(r => [r.creator ?? '', r.date, r.timestamp, Number(r.amount.toFixed(6)), r.transactionType, r.chatter ?? '', r.chatterStatus, r.platform]);
        const theirs = ref.tables[0].rows.map(r => [r[0], r[1], r[2], Number(Number(r[3]).toFixed(6)), r[4], r[5], r[6], r[7]]);
        expect(mine.map(key).sort()).toEqual(theirs.map(key).sort());
        // Highest amounts first, as in the Python app.
        expect(mine.map(r => r[3])).toEqual(theirs.map(r => r[3]));
        expect(result.filterOptions.transaction_type).toEqual(ref.selects!.tx_type);
    }, 120_000);
});
