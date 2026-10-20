import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {canCompare, captureRateFor, pyCompact, pyFixed, pyMoney, RANGES, refPage} from '../test-support/reference.js';
import {performanceHub, performanceHub2} from './performance-hub.js';

// Performance Hub 1 and 2 against the Python app's captured pages (four
// reporting weeks ending with the range's end date; Friday week start).

function cell(value: string | number | null): unknown {
    return typeof value === 'number' ? expect.closeTo(value, 6) : value;
}

const num = (v: number) => pyFixed(v, 1);

describe.skipIf(!canCompare)('Performance Hub parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('hub 1 %s', async (name, _start, end) => {
        const ref = refPage(name, '/c-hub/performance');
        const card = (label: string) => ref.cards.find(c => c.label === label)!;
        const r = await performanceHub(getFlowPool(), {end, weekStart: 'Friday', eurUsdRate: captureRateFor(name, '/c-hub/performance')});
        const latest = r.weeks[r.weeks.length - 1];
        const previous = r.weeks[r.weeks.length - 2];
        const gap = latest.teamStrength - latest.modelRequirement;
        const chatterChange = latest.scheduledChatters - previous.scheduledChatters;
        expect({
            strength: pyCompact(latest.teamStrength),
            potential: latest.modelRequirement ? `${pyFixed(latest.teamStrength / latest.modelRequirement * 100, 1)}%` : 'n/a',
            requirement: pyCompact(latest.modelRequirement),
            gap: pyCompact(gap, gap >= 0 ? '+' : ''),
            signal: chatterChange > 0 ? 'Stronger' : chatterChange < 0 ? 'Weaker' : 'Stable',
            signalNote: `${pyCompact(chatterChange, chatterChange >= 0 ? '+' : '')} scheduled vs previous week`,
            chatters: pyCompact(latest.scheduledChatters),
            hours: pyCompact(latest.hours),
            profiles: latest.scheduledChatters ? `${latest.hrMatchedChatters}/${latest.scheduledChatters} scheduled chatters matched to HR` : 'no scheduled chatters',
            revPerHour: latest.hours ? pyMoney(latest.revenue / latest.hours) : 'n/a',
        }).toEqual({
            strength: card('Team Strength').value, potential: card('Operating Potential').value, requirement: card('Model Requirement').value,
            gap: card('Capacity Gap').value, signal: card('Hiring Signal').value, signalNote: card('Hiring Signal').note,
            chatters: card('Scheduled Chatters').value, hours: card('Scheduled Hours').value, profiles: card('HR Profiles').value,
            revPerHour: card('Rev / Hour').value,
        });
        const [requirements, transition] = ref.tables;
        expect(r.creators.slice(0, 25).map(c => [c.creator, c.creatorId, c.revenue, c.modelTier, c.requirement, c.modelTierSource]))
            .toEqual(requirements.rows.map(row => row.map(cell)));
        // HR status is live in Flow (Xaviera became inactive after the capture,
        // which shifts the top 25), so check the captured people are all still listed.
        expect(r.transition.map(t => [t.chatter, t.status, t.team, t.tier, t.skillGrade])).toEqual(expect.arrayContaining(transition.rows.map(row => row.map(cell))));
    }, 180_000);

    it.each(RANGES)('hub 2 %s', async (name, _start, end) => {
        const ref = refPage(name, '/c-hub/performance-2');
        const card = (label: string) => ref.cards.find(c => c.label === label)!;
        const r = await performanceHub2(getFlowPool(), {end, weekStart: 'Friday', eurUsdRate: captureRateFor(name, '/c-hub/performance-2')});
        const latest = r.weeks[r.weeks.length - 1];
        const previous = r.weeks[r.weeks.length - 2];
        const gap = latest.teamStrength - latest.modelRequirement;
        expect({
            strength: `${num(latest.teamStrength)}h`, requirement: `${num(latest.modelRequirement)}h`, gap: `${num(gap)}h`,
            gapNote: gap < 0 ? 'shortage' : 'surplus',
            potential: latest.modelRequirement ? `${pyFixed(latest.teamStrength / latest.modelRequirement * 100, 1)}%` : 'n/a',
            growth: `${num(latest.teamStrength - previous.teamStrength)}h`, capacity: `${num(latest.capacityHours)}h`, hours: `${num(latest.hours)}h`,
            utilization: `${num(latest.utilizationPct)}%`,
            coverage: latest.scheduledChatters ? `${latest.hrMatchedChatters} of ${latest.scheduledChatters} scheduled chatters have score profiles` : 'no scheduled chatters',
            coverageNote: `${latest.capacityMissingChatters} missing capacity`,
        }).toEqual({
            strength: card('Team Strength').value, requirement: card('Model Requirement').value, gap: card('Capacity Gap').value,
            gapNote: card('Capacity Gap').note, potential: card('Operating Potential').value, growth: card('Strength Growth').value,
            capacity: card('Weekly Capacity').value, hours: card('Chatter Hours').value, utilization: card('Utilization').value,
            coverage: card('HR Data Coverage').value, coverageNote: card('HR Data Coverage').note,
        });
        const [requirements, transition, detail] = ref.tables;
        expect(r.creators.slice(0, 25).map(c => [c.creator, c.creatorId, c.revenue, c.modelTier, c.requiredWeeklyHours, c.modelTierSource]))
            .toEqual(requirements.rows.map(row => row.map(cell)));
        // HR status is live in Flow (Xaviera became inactive after the capture,
        // which shifts the top 25), so check the captured people are all still listed.
        expect(r.transition.map(t => [t.chatter, t.status, t.team, t.tier, t.skillGrade])).toEqual(expect.arrayContaining(transition.rows.map(row => row.map(cell))));
        expect(r.current.map(c => [
            c.chatter, c.tier, c.skillGrade, c.chatQuality, c.activityBehaviour, c.weeklyCapacityHours, c.scheduledHours, c.capacityGapHours,
            c.utilizationPct, c.qualityAdjustedCapacity, c.qualityAdjustedScheduled, c.revenue, c.revPerHour, c.notionTier, c.team,
            c.hrProfileFound ? 'True' : 'False', c.scorePending ? 'True' : 'False', c.capacityMissing ? 'True' : 'False', c.capacitySource,
            c.latestGradeDate ?? '',
        ])).toEqual(detail.rows.map(row => row.map(cell)));
    }, 180_000);
});
