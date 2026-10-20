// Inactivity "money wasted": a port of the Python app's
// _schedule_matched_inactivity_rows and _reprice_inactivity_money_wasted
// (app/web.py). Kept as one pure function so it can be tested on its own.
//
// 1. Only inactivity that overlaps a worked shift of the same chatter counts;
//    an episode's minutes are capped at that overlap.
// 2. Each model gets a revenue rate: tips + messages per worked shift hour,
//    overall and per Sarajevo clock hour.
// 3. Each episode is priced hour by hour: the model's own rate for that hour,
//    else the tier's median for that hour, else the overall median for that
//    hour, else the model's overall rate (or its tier/overall median).
//    Fallback rates are capped per tier (max of the 75th percentile and twice
//    the median); a model's own hourly rate is not capped.

export interface ShiftInput {
    creatorId: string;
    creator: string | null;
    chatterId: string;
    chatter: string | null;
    startUs: number;
    // Clock-out; null while the shift is open.
    endUs: number | null;
    // Worked hours (an open shift counts up to now).
    shiftHours: number;
}

export interface EpisodeInput {
    // Episode id and chatter id (Python: transaction_key "inactivity|<id>|<chatter id>").
    key: string;
    creatorId: string;
    creator: string | null;
    chatterId: string;
    chatter: string | null;
    startUs: number;
    endUs: number | null;
    inactiveMinutes: number;
    peakUnread: number;
    platform: string | null;
    team: string | null;
}

// Tips + messages revenue (EUR) of one model in one Sarajevo clock hour.
export interface RevenueInput {
    creatorId: string;
    creatorKey: string;
    localHour: number | null;
    revenue: number;
}

export interface CreatorTier {
    creatorId: string;
    creator: string | null;
    tier: string;
}

export interface PricedEpisode extends EpisodeInput {
    // Minutes overlapping a worked shift (capped at the reported minutes).
    scheduledMinutes: number;
    moneyWasted: number;
    hourlyRate: number;
    creatorTier: string;
}

// Timestamps are integer epoch microseconds: exact in a JavaScript number, and
// computed like pandas' nanosecond Timestamps. With float milliseconds, tiny
// shift slices (revenue / a few seconds of shift time) amplified rounding
// errors to ~1e-8 of the result.
const HOUR_US = 3_600_000_000;
const SECOND_US = 1_000_000;

const sarajevoHour = new Intl.DateTimeFormat('en-GB', {timeZone: 'Europe/Sarajevo', hour: '2-digit', hourCycle: 'h23'});

function localHour(us: number): number {
    return Number(sarajevoHour.format(new Date(Math.floor(us / 1000))));
}

// Python: _creator_key.
export function creatorKey(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase();
}

// Python: _interval_hour_segments. Splits [start, end) at whole UTC hours
// (Sarajevo offsets are whole hours) and labels each piece with its Sarajevo hour.
export function hourSegments(startUs: number | null, endUs: number | null): [hour: number, hours: number][] {
    if (startUs === null || endUs === null || endUs <= startUs) return [];
    const segments: [number, number][] = [];
    let cursor = startUs;
    while (cursor < endUs) {
        const nextHour = Math.floor(cursor / HOUR_US) * HOUR_US + HOUR_US;
        const segmentEnd = Math.min(nextHour, endUs);
        // Python: Timedelta.total_seconds() / 3600
        const hours = Math.max(0, (segmentEnd - cursor) / SECOND_US / 3600);
        if (hours) segments.push([localHour(cursor), hours]);
        cursor = segmentEnd;
    }
    return segments;
}

// pandas Series.median (NaN for no values).
export function median(values: number[]): number {
    if (!values.length) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// pandas Series.quantile, default linear interpolation.
export function quantile(values: number[], q: number): number {
    if (!values.length) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// Python's max() with NaN: max(nan, x) is nan when nan comes first, else x.
function pyMax(a: number, b: number): number {
    if (Number.isNaN(a)) return a;
    if (Number.isNaN(b)) return a;
    return a >= b ? a : b;
}

function pyMin(a: number, b: number): number {
    if (Number.isNaN(a)) return a;
    if (Number.isNaN(b)) return a;
    return a <= b ? a : b;
}

function groupSum<T>(items: T[], key: (item: T) => string, value: (item: T) => number): Map<string, number> {
    const totals = new Map<string, number>();
    for (const item of items) {
        const k = key(item);
        totals.set(k, (totals.get(k) ?? 0) + value(item));
    }
    return totals;
}

// Python: _creator_tier_maps. Tiers normalised to A/B/C; rows sorted by tier
// (A first) and name, so for a model with several accounts the last one wins,
// as with the Python dict comprehension.
export function tierMaps(tiers: CreatorTier[]): {byId: Map<string, string>; byName: Map<string, string>} {
    const normalised = tiers
        .map(t => {
            const text = (t.tier ?? '').trim().toUpperCase();
            const tier = text.includes('A') ? 'A' : text.includes('B') ? 'B' : text.includes('C') ? 'C' : '';
            return {...t, tier};
        })
        .filter(t => t.tier);
    const rank: Record<string, number> = {A: 3, B: 2, C: 1};
    normalised.sort((a, b) => (rank[b.tier] - rank[a.tier])
        || ((a.creator ?? '￿') < (b.creator ?? '￿') ? -1 : (a.creator ?? '￿') > (b.creator ?? '￿') ? 1 : 0));
    const byId = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const t of normalised) {
        if (t.creatorId.trim()) byId.set(t.creatorId.trim(), t.tier);
        if (creatorKey(t.creator)) byName.set(creatorKey(t.creator), t.tier);
    }
    return {byId, byName};
}

// Python: _schedule_matched_inactivity_rows. Episodes without an overlapping
// shift of the same chatter (by id, else by lower-case name) are dropped.
export function matchEpisodesToShifts(episodes: EpisodeInput[], shifts: ShiftInput[]): (EpisodeInput & {scheduledMinutes: number})[] {
    if (!shifts.length) return [];
    const usable = shifts
        .map(s => ({...s, end: s.endUs ?? s.startUs + Math.round(s.shiftHours * HOUR_US), matchId: s.chatterId.trim(), matchName: creatorKey(s.chatter)}));
    const byId = new Map<string, typeof usable>();
    const byName = new Map<string, typeof usable>();
    for (const shift of usable) {
        byId.set(shift.matchId, [...(byId.get(shift.matchId) ?? []), shift]);
        byName.set(shift.matchName, [...(byName.get(shift.matchName) ?? []), shift]);
    }
    const matched: (EpisodeInput & {scheduledMinutes: number})[] = [];
    for (const episode of episodes) {
        const start = episode.startUs;
        const end = episode.endUs ?? episode.startUs;
        const id = episode.chatterId.trim();
        const candidates = id ? byId.get(id) ?? [] : byName.get(creatorKey(episode.chatter)) ?? [];
        const overlaps = candidates.filter(s => s.startUs <= end && s.end >= start);
        if (!overlaps.length) continue;
        let minutes = 0;
        for (const shift of overlaps) {
            // Python: Timedelta.total_seconds() / 60
            minutes += Math.max(0, (Math.min(end, shift.end) - Math.max(start, shift.startUs)) / SECOND_US / 60);
        }
        const reported = episode.inactiveMinutes || 0;
        matched.push({...episode, scheduledMinutes: reported ? Math.min(reported, minutes) : minutes});
    }
    return matched;
}

// Python: _reprice_inactivity_money_wasted. `revenue` must already be empty
// when the period has no model revenue (Python: model_revenue_source).
export function priceEpisodes(
    episodes: (EpisodeInput & {scheduledMinutes: number})[],
    shifts: ShiftInput[],
    revenue: RevenueInput[],
    tiers: {byId: Map<string, string>; byName: Map<string, string>},
): PricedEpisode[] {
    const tierOf = (creatorId: string, key: string) => tiers.byId.get(creatorId) ?? tiers.byName.get(key) ?? '';
    // Without shifts or rates the Python app returns no tier at all, which its
    // tier table shows as "Unassigned".
    const unpriced = (): PricedEpisode[] => episodes.map(e => ({
        ...e, inactiveMinutes: e.scheduledMinutes, moneyWasted: 0, hourlyRate: 0, creatorTier: 'Unassigned',
    }));
    if (!shifts.length) return unpriced();

    const shiftRows = shifts.map(s => ({...s, creatorId: s.creatorId.trim(), key: creatorKey(s.creator)}));
    const revenueById = groupSum(revenue.filter(r => r.creatorId), r => r.creatorId, r => r.revenue);
    const revenueByName = groupSum(revenue.filter(r => r.creatorKey), r => r.creatorKey, r => r.revenue);
    const hoursById = groupSum(shiftRows.filter(s => s.creatorId), s => s.creatorId, s => s.shiftHours);
    const hoursByName = groupSum(shiftRows.filter(s => s.key), s => s.key, s => s.shiftHours);

    // One overall rate per distinct shift creator (id, name, key) with hours.
    const seen = new Set<string>();
    const rates: {creatorId: string; key: string; tier: string; rate: number}[] = [];
    for (const s of shiftRows) {
        const identity = JSON.stringify([s.creatorId, s.creator, s.key]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const total = revenueById.get(s.creatorId) ?? revenueByName.get(s.key) ?? 0;
        const hours = hoursById.get(s.creatorId) ?? hoursByName.get(s.key) ?? 0;
        if (hours <= 0) continue;
        rates.push({creatorId: s.creatorId, key: s.key, tier: tierOf(s.creatorId, s.key), rate: Math.max(0, total / hours)});
    }
    if (!rates.length) return unpriced();

    // Worked hours per model and Sarajevo hour (closed shifts only).
    const shiftHoursById = new Map<string, number>();
    const shiftHoursByName = new Map<string, number>();
    let anySegments = false;
    for (const s of shiftRows) {
        for (const [hour, hours] of hourSegments(s.startUs, s.endUs)) {
            anySegments = true;
            if (s.creatorId) shiftHoursById.set(`${s.creatorId}|${hour}`, (shiftHoursById.get(`${s.creatorId}|${hour}`) ?? 0) + hours);
            if (s.key) shiftHoursByName.set(`${s.key}|${hour}`, (shiftHoursByName.get(`${s.key}|${hour}`) ?? 0) + hours);
        }
    }
    // Hourly rates: matched by id, and separately by name (both kept, as in Python).
    const hourly: {creatorId: string; key: string; hour: number; rate: number}[] = [];
    if (anySegments) {
        const withHour = revenue.filter(r => r.localHour !== null);
        const revHourId = groupSum(withHour.filter(r => r.creatorId), r => `${r.creatorId}|${r.localHour}`, r => r.revenue);
        const revHourName = groupSum(withHour.filter(r => r.creatorKey), r => `${r.creatorKey}|${r.localHour}`, r => r.revenue);
        for (const [k, rev] of revHourId) {
            const hours = shiftHoursById.get(k);
            if (hours === undefined) continue;
            const [creatorId, hour] = k.split('|');
            hourly.push({creatorId, key: '', hour: Number(hour), rate: hours ? rev / hours : 0});
        }
        for (const [k, rev] of revHourName) {
            const hours = shiftHoursByName.get(k);
            if (hours === undefined) continue;
            const separator = k.lastIndexOf('|');
            hourly.push({creatorId: '', key: k.slice(0, separator), hour: Number(k.slice(separator + 1)), rate: hours ? rev / hours : 0});
        }
    }
    const hourlyRates = hourly.filter(h => h.rate >= 0);

    const tierMedians = new Map<string, number>();
    for (const tier of new Set(rates.map(r => r.tier).filter(Boolean))) {
        tierMedians.set(tier, median(rates.filter(r => r.tier === tier).map(r => r.rate)));
    }
    const overallMedian = median(rates.map(r => r.rate));

    const hourlyById = new Map<string, number>();
    const hourlyByName = new Map<string, number>();
    for (const h of hourlyRates) {
        if (h.creatorId) hourlyById.set(`${h.creatorId}|${h.hour}`, h.rate);
        if (h.key) hourlyByName.set(`${h.key}|${h.hour}`, h.rate);
    }
    const withTiers = hourlyRates.map(h => ({...h, tier: tierOf(h.creatorId, h.key)}));
    const tierHourMedians = new Map<string, number>();
    for (const k of new Set(withTiers.filter(h => h.tier).map(h => `${h.tier}|${h.hour}`))) {
        tierHourMedians.set(k, median(withTiers.filter(h => h.tier && `${h.tier}|${h.hour}` === k).map(h => h.rate)));
    }
    const overallHourMedians = new Map<number, number>();
    for (const hour of new Set(withTiers.map(h => h.hour))) {
        overallHourMedians.set(hour, median(withTiers.filter(h => h.hour === hour).map(h => h.rate)));
    }

    const tierCaps = new Map<string, number>();
    for (const tier of new Set(rates.map(r => r.tier).filter(Boolean))) {
        const values = rates.filter(r => r.tier === tier).map(r => r.rate);
        tierCaps.set(tier, pyMax(quantile(values, 0.75), median(values) * 2));
    }
    const overallCap = pyMax(quantile(rates.map(r => r.rate), 0.9), overallMedian * 2);

    const rateById = new Map<string, number>();
    const rateByName = new Map<string, number>();
    for (const r of rates) {
        if (r.creatorId) rateById.set(r.creatorId, r.rate);
        if (r.key) rateByName.set(r.key, r.rate);
    }

    function eventRate(creatorId: string, key: string, tier: string): number {
        let rate = rateById.get(creatorId) ?? rateByName.get(key);
        if (rate === undefined) rate = tierMedians.get(tier) ?? overallMedian;
        const cap = tierCaps.get(tier) ?? overallCap;
        return pyMax(0, pyMin(rate, cap));
    }

    function eventHourRate(creatorId: string, key: string, tier: string, hour: number): number {
        let rate = hourlyById.get(`${creatorId}|${hour}`) ?? hourlyByName.get(`${key}|${hour}`);
        if (rate !== undefined) return pyMax(0, rate);
        rate = tierHourMedians.get(`${tier}|${hour}`) ?? overallHourMedians.get(hour) ?? eventRate(creatorId, key, tier);
        const cap = tierCaps.get(tier) ?? overallCap;
        return pyMax(0, pyMin(rate, cap));
    }

    return episodes.map(event => {
        const creatorId = event.creatorId.trim();
        const key = creatorKey(event.creator);
        const tier = tierOf(creatorId, key);
        const segments = hourSegments(event.startUs, event.endUs);
        const scheduledHours = (event.scheduledMinutes || 0) / 60;
        let total: number;
        if (scheduledHours && segments.length) {
            const raw = segments.reduce((sum, [, hours]) => sum + hours, 0);
            const scale = raw ? Math.min(1, scheduledHours / raw) : 1;
            total = segments.reduce((sum, [hour, hours]) => sum + hours * scale * eventHourRate(creatorId, key, tier, hour), 0);
        } else {
            total = scheduledHours * eventRate(creatorId, key, tier);
        }
        return {
            ...event,
            inactiveMinutes: event.scheduledMinutes,
            moneyWasted: total,
            hourlyRate: scheduledHours ? total / scheduledHours : 0,
            creatorTier: tier || 'Unassigned',
        };
    });
}
