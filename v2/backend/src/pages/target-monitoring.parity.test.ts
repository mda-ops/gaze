import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {canCompare, captureRateFor, pyMoney as money, RANGES, refPage} from '../test-support/reference.js';
import {targetMonitoring} from './target-monitoring.js';

// Target Monitoring against the Python app's captured page.

describe.skipIf(!canCompare)('Target Monitoring parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s', async (name, start, end) => {
        const ref = refPage(name, '/c-hub/target-monitoring');
        const card = (label: string) => ref.cards.find(c => c.label === label)!.value;
        const r = await targetMonitoring(getFlowPool(), {start, end, eurUsdRate: captureRateFor(name, '/c-hub/target-monitoring')});
        const s = r.summary;

        expect([String(s.models), String(s.increase), String(s.keep), String(s.decrease), String(s.needsTarget), `${s.medianHitRate.toFixed(1)}%`])
            .toEqual([card('Models'), card('Increase'), card('Keep'), card('Decrease'), card('Needs Target'), card('Median Hit Rate')]);

        expect(r.rows.map(x => [
            x.model, x.platform, x.currentTarget ? money(x.currentTarget) : 'Needs Target', x.hitDays, `${x.hitRate.toFixed(1)}%`,
            money(x.medianHitDays), money(x.averageHitDays), money(x.medianAllDays), money(x.averageAllDays), x.action,
            money(x.suggestedTarget), money(x.suggestedTargetMedian), money(x.suggestedTarget),
        ])).toEqual(ref.tables[0].rows);
    }, 120_000);
});
