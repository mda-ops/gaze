import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {emptyFilters} from '../lib/filters.js';
import {pyMoney} from '../lib/py-format.js';
import {canCompare, captureRateFor, RANGES, refHtml} from '../test-support/reference.js';
import {ask} from './ask.js';

// /ask with its default question against the Python app's captured answer.

describe.skipIf(!canCompare)('Ask parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const expected = refHtml(name, '/ask').match(/<p class='answer'>(.*?)<\/p>/)![1];
        const result = await ask(getFlowPool(), {
            start, end, compare: 'Previous period', filters: emptyFilters(), question: 'Who improved the most?', eurUsdRate: captureRateFor(name, '/ask'),
        });
        const a = result.answer;
        expect(a.kind).toBe('improved');
        if (a.kind === 'improved') expect(`${a.chatter} improved the most, up ${pyMoney(a.changeAmount)}.`).toBe(expected);
    }, 120_000);
});
