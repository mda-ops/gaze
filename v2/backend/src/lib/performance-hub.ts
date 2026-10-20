// Performance Hub 1 and 2: a port of the Python app's performance_hub.py.
// Pure functions over compact inputs (see pages/performance-hub.ts for the
// queries). Python quirks are reproduced on purpose so numbers match:
// - grades are joined to shifts by first name only, so two chatters with the
//   same first name multiply each other's rows;
// - Flow's grade "Notes" text is read as a "personalisation" score when it
//   happens to be a number (the Python column matching picks "Notes").

import type {IsoDate} from './period.js';

export interface GradeInput {
    name: string;
    status: string | null;
    team: string | null;
    chatQuality: number | null;
    activity: number | null;
    notes: string | null;
    // Python str(Timestamp): "YYYY-MM-DD HH:MM:SS[.ffffff]+00:00".
    latestGradeDate: string | null;
}

export interface RosterRow {
    name: string;
    firstNameKey: string;
    status: string;
    team: string;
    currentTier: string;
    chattingQuality: number;
    activityBehaviour: number;
    skillGrade: number;
    skillTier: string;
    weeklyCapacityHours: number;
    latestGradeDate: string | null;
    hrMatch: boolean;
    scorePending: boolean;
}

export interface HubShift {
    date: IsoDate;
    chatter: string;
    startUs: number;
    endUs: number | null;
    shiftHours: number;
}

// Revenue per day, chatter and creator (EUR).
export interface HubRevenue {
    date: IsoDate;
    chatter: string | null;
    creator: string | null;
    creatorId: string | null;
    revenue: number;
}

export interface HubScheduled {
    date: IsoDate;
    chatter: string | null;
    hours: number;
}

export interface OfficialTierInput {
    creator: string | null;
    creatorId: string | null;
    tier: string | null;
}

// Python: _clean_number.
export function cleanNumber(value: unknown): number {
    if (value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))) return 0;
    const text = String(value).trim().replace(/,/g, '').replace(/%/g, '').replace(/EUR/g, '').replace(/\$/g, '');
    if (!text || ['nan', 'none', 'n/a'].includes(text.toLowerCase())) return 0;
    // Python float(): decimal or exponent notation, surrounding spaces allowed.
    if (!/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(text)) {
        const lowered = text.trim().toLowerCase();
        if (['inf', '+inf', 'infinity', '+infinity'].includes(lowered)) return Infinity;
        if (['-inf', '-infinity'].includes(lowered)) return -Infinity;
        return 0;
    }
    return Number(text);
}

// Python: _score. 0-1 and 0-10 scales become 0-100.
export function score(value: unknown): number {
    let number = cleanNumber(value);
    if (number <= 0) return 0;
    if (number <= 1) number *= 100;
    if (number <= 10) number *= 10;
    return Math.max(0, Math.min(100, number));
}

export function skillTier(grade: number): string {
    if (grade >= 85) return 'A';
    if (grade >= 75) return 'B';
    if (grade >= 65) return 'C';
    return 'Needs coaching';
}

// Python: _first_name.
export function firstNameKey(value: string | null | undefined): string {
    return (value ?? '').trim().split(' ')[0].toLowerCase();
}

// Python: _normalized_chatter_rows over Flow's chatter grades (every row has
// Role "Chatter"; no capacity, emotional, tone, BWC or responsiveness columns).
export function rosterFromGrades(grades: GradeInput[]): RosterRow[] {
    return grades
        .filter(g => (g.name ?? '').trim() !== '')
        .map(g => {
            const name = g.name.trim();
            const directQuality = score(g.chatQuality);
            const directActivity = score(g.activity);
            const directPresent = directQuality > 0 || directActivity > 0;
            const personalisation = score(g.notes);
            const chattingQuality = directQuality > 0 ? directQuality : 0;
            // Personalisation alone is the weighted activity average when present.
            const activityBehaviour = directActivity > 0 ? directActivity : personalisation > 0 ? personalisation : chattingQuality;
            const fallbackGrade = chattingQuality * 0.65 + activityBehaviour * 0.35;
            const raw = directPresent ? fallbackGrade : personalisation > 0 ? personalisation : fallbackGrade;
            const skillGrade = Math.max(0, Math.min(100, raw || 0));
            const team = (g.team ?? '').trim() || 'Unknown';
            return {
                name,
                firstNameKey: firstNameKey(name),
                status: (g.status ?? '').trim(),
                team,
                currentTier: 'Unassigned',
                chattingQuality,
                activityBehaviour,
                skillGrade,
                skillTier: skillTier(skillGrade),
                weeklyCapacityHours: 0,
                latestGradeDate: g.latestGradeDate,
                hrMatch: true,
                scorePending: skillGrade <= 0,
            };
        });
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function addDays(date: IsoDate, days: number): IsoDate {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

// Python: week_windows. Four reporting weeks ending with the one holding `end`.
export function weekWindows(end: IsoDate, weekStart = 'Friday', count = 4): {label: string; start: IsoDate; end: IsoDate}[] {
    const weekday = (new Date(`${end}T00:00:00Z`).getUTCDay() + 6) % 7;
    const currentStart = addDays(end, -((weekday - WEEKDAYS.indexOf(weekStart) + 7) % 7));
    const windows = [];
    for (let offset = count - 1; offset >= 0; offset--) {
        const start = addDays(currentStart, -offset * 7);
        const sixth = addDays(start, 6);
        windows.push({label: `W${count - offset}`, start, end: offset === 0 ? (sixth < end ? sixth : end) : sixth});
    }
    return windows;
}

const assigned = (chatter: string | null) => {
    const name = (chatter ?? '').trim();
    return name !== '' && name.toLowerCase() !== 'unknown';
};

// Python's pd.to_datetime(shift_start/shift_end text) without a format infers
// the format from the first value, which has fractional seconds; a timestamp
// with exactly zero microseconds prints without a fraction and becomes NaT.
// Such a shift is then not an interval (it can still count via the longest
// shift of a day without intervals). Reproduced so the hours match.
const parsedByPandas = (us: number | null) => us !== null && us % 1_000_000 !== 0;

// Python: _hours_by_chatter. Overlapping shifts of a chatter on a day count
// once; a day without usable intervals counts its longest shift.
export function hoursByChatter(shifts: HubShift[]): Map<string, number> {
    const days = new Map<string, HubShift[]>();
    for (const s of shifts) {
        if (!assigned(s.chatter)) continue;
        const key = `${s.chatter}\u0000${s.date}`;
        days.set(key, [...(days.get(key) ?? []), s]);
    }
    const totals = new Map<string, number>();
    for (const [key, group] of days) {
        const chatter = key.split('\u0000')[0];
        const intervals = group.filter(s => parsedByPandas(s.startUs) && parsedByPandas(s.endUs)).sort((a, b) => a.startUs - b.startUs);
        let total = 0;
        if (intervals.length) {
            let start = intervals[0].startUs;
            let end = intervals[0].endUs!;
            for (const s of intervals.slice(1)) {
                if (s.startUs <= end) {
                    end = Math.max(end, s.endUs!);
                } else {
                    total += Math.max(0, (end - start) / 1_000_000 / 3600);
                    start = s.startUs;
                    end = s.endUs!;
                }
            }
            total += Math.max(0, (end - start) / 1_000_000 / 3600);
        } else {
            total = Math.max(...group.map(s => s.shiftHours));
        }
        totals.set(chatter, (totals.get(chatter) ?? 0) + total);
    }
    return totals;
}

// Python: _revenue_by_chatter.
export function revenueByChatter(revenue: HubRevenue[]): Map<string, number> {
    const totals = new Map<string, number>();
    for (const r of revenue) {
        if (!assigned(r.chatter)) continue;
        totals.set(r.chatter!, (totals.get(r.chatter!) ?? 0) + r.revenue);
    }
    return totals;
}

function normaliseCreatorTier(value: string | null): string {
    const text = (value ?? '').trim().toUpperCase();
    if (!text || ['NAN', 'NONE', 'UNASSIGNED'].includes(text)) return '';
    if (text.includes('A')) return 'A';
    if (text.includes('B')) return 'B';
    if (text.includes('C')) return 'C';
    return '';
}

// Python: _official_creator_tiers. The highest tier per creator id, then per name.
export function officialTiers(rows: OfficialTierInput[]): {byId: Map<string, string>; byName: Map<string, string>} {
    const rank: Record<string, number> = {A: 3, B: 2, C: 1};
    const tiers = rows
        .map(r => ({creator: r.creator, creatorId: (r.creatorId ?? '').trim(), key: (r.creator ?? '').trim().toLowerCase(), tier: normaliseCreatorTier(r.tier)}))
        .filter(r => r.tier)
        .sort((a, b) => (rank[b.tier] - rank[a.tier]) || ((a.creator ?? '￿') < (b.creator ?? '￿') ? -1 : (a.creator ?? '￿') > (b.creator ?? '￿') ? 1 : 0));
    const byId = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const t of tiers) {
        if (t.creatorId && !byId.has(t.creatorId)) byId.set(t.creatorId, t.tier);
    }
    for (const t of tiers) {
        if (t.key && !byName.has(t.key)) byName.set(t.key, t.tier);
    }
    return {byId, byName};
}

export interface CreatorRequirement {
    creator: string;
    creatorId: string | null;
    revenue: number;
    modelTier: string;
    requirement: number;
    requiredWeeklyHours: number;
    modelTierSource: string;
}

const REQUIREMENT_POINTS: Record<string, number> = {A: 4200, B: 3000, C: 1800};
const REQUIRED_WEEKLY_HOURS: Record<string, number> = {A: 168, B: 112, C: 56};

// Python: _creator_requirement / _creator_capacity_requirement. Each model's
// official tier, else a tier estimated from its revenue in the week.
export function creatorRequirements(revenue: HubRevenue[], tiers: ReturnType<typeof officialTiers>): CreatorRequirement[] {
    const groups = new Map<string, {creator: string | null; creatorId: string | null; revenue: number}>();
    for (const r of revenue) {
        const key = `${r.creator ?? '\u0001'}\u0000${r.creatorId ?? '\u0001'}`;
        const g = groups.get(key) ?? {creator: r.creator, creatorId: r.creatorId, revenue: 0};
        g.revenue += r.revenue;
        groups.set(key, g);
    }
    return [...groups.values()]
        .filter(g => (g.creator ?? '').trim() !== '')
        .map(g => {
            const estimated = g.revenue >= 10_000 ? 'A' : g.revenue >= 5_000 ? 'B' : 'C';
            const official = (g.creatorId !== null ? tiers.byId.get(g.creatorId) : undefined)
                ?? tiers.byName.get(g.creator!.trim().toLowerCase()) ?? '';
            const modelTier = official || estimated;
            return {
                creator: g.creator!,
                creatorId: g.creatorId,
                revenue: g.revenue,
                modelTier,
                requirement: REQUIREMENT_POINTS[modelTier] ?? 1800,
                requiredWeeklyHours: REQUIRED_WEEKLY_HOURS[modelTier] ?? 56,
                modelTierSource: official ? 'creator_accounts' : 'estimated from revenue',
            };
        })
        .sort((a, b) => b.revenue - a.revenue);
}

const STATUS_ORDER: Record<string, number> = {
    'probee': 0, 'ready to start chatting': 1, "didn't finish training": 2, 'inactive': 3, 'left': 4, 'fired': 5,
};

// Python: _transition_watch_rows. People whose HR status is not "active".
export function transitionWatch(roster: RosterRow[]): {chatter: string; status: string; team: string; tier: string; skillGrade: number}[] {
    const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return roster
        .filter(r => r.status !== '' && r.status.toLowerCase() !== 'active')
        .sort((a, b) => ((STATUS_ORDER[a.status.toLowerCase()] ?? 9) - (STATUS_ORDER[b.status.toLowerCase()] ?? 9))
            || text(a.team, b.team) || text(a.name, b.name))
        .map(r => ({chatter: r.name, status: r.status, team: r.team, tier: r.currentTier, skillGrade: r.skillGrade}));
}

const inPeriod = <T extends {date: IsoDate}>(rows: T[], start: IsoDate, end: IsoDate) => rows.filter(r => r.date >= start && r.date <= end);

// ---------------------------------------------------------------- Hub 1

export interface HubChatter {
    chatter: string;
    tier: string;
    skillGrade: number;
    chatQuality: number;
    activityBehaviour: number;
    scheduledHours: number;
    operatingPotential: number;
    revenue: number;
    revPerHour: number;
    notionTier: string;
    team: string;
    hrProfileFound: boolean;
    scorePending: boolean;
    latestGradeDate: string | null;
}

export interface HubWeek {
    week: string;
    start: IsoDate;
    end: IsoDate;
    teamStrength: number;
    modelRequirement: number;
    gap: number;
    scheduledChatters: number;
    hours: number;
    revenue: number;
    revenuePerHour: number;
    hrMatchedChatters: number;
}

export function buildHub1(input: {
    end: IsoDate; weekStart: string; roster: RosterRow[]; shifts: HubShift[]; revenue: HubRevenue[]; tiers: ReturnType<typeof officialTiers>;
}) {
    const weeks: HubWeek[] = [];
    let current: HubChatter[] = [];
    let currentCreators: CreatorRequirement[] = [];
    for (const w of weekWindows(input.end, input.weekStart)) {
        const hours = hoursByChatter(inPeriod(input.shifts, w.start, w.end));
        const revenueRows = inPeriod(input.revenue, w.start, w.end);
        const revenue = revenueByChatter(revenueRows);
        // Left join on first name: every matching grade row, or one unmatched row.
        const active: HubChatter[] = [];
        for (const [chatter, chatterHours] of hours) {
            const matches = input.roster.filter(r => r.firstNameKey === firstNameKey(chatter));
            const chatterRevenue = revenue.get(chatter) ?? 0;
            for (const r of matches.length ? matches : [null]) {
                const grade = r?.skillGrade ?? 0;
                const pending = grade <= 0;
                active.push({
                    chatter: r ? r.name : chatter,
                    tier: pending ? 'Pending score' : (r ? r.skillTier : skillTier(grade)),
                    skillGrade: grade > 0 ? grade : 0,
                    chatQuality: r ? r.chattingQuality : grade,
                    activityBehaviour: r ? r.activityBehaviour : grade,
                    scheduledHours: chatterHours,
                    operatingPotential: grade * chatterHours,
                    revenue: chatterRevenue,
                    revPerHour: chatterHours ? chatterRevenue / chatterHours : 0,
                    notionTier: r?.currentTier || 'Unassigned',
                    team: r?.team || 'Unknown',
                    hrProfileFound: Boolean(r && r.name.trim()),
                    scorePending: pending,
                    latestGradeDate: r?.latestGradeDate ?? null,
                });
            }
        }
        const creators = creatorRequirements(revenueRows, input.tiers);
        const strength = active.reduce((s, a) => s + a.operatingPotential, 0);
        const requirement = creators.reduce((s, c) => s + c.requirement, 0);
        const hoursTotal = active.reduce((s, a) => s + a.scheduledHours, 0);
        const revenueTotal = active.reduce((s, a) => s + a.revenue, 0);
        weeks.push({
            week: w.label, start: w.start, end: w.end, teamStrength: strength, modelRequirement: requirement, gap: strength - requirement,
            scheduledChatters: hours.size, hours: hoursTotal, revenue: revenueTotal,
            revenuePerHour: hoursTotal ? revenueTotal / hoursTotal : 0,
            hrMatchedChatters: active.filter(a => a.hrProfileFound).length,
        });
        current = active;
        currentCreators = creators;
    }
    current = [...current].sort((a, b) => b.operatingPotential - a.operatingPotential);
    return {weeks, current, tierMix: tierMix(current, c => c.operatingPotential), creators: currentCreators};
}

function tierMix<T extends {tier: string}>(rows: T[], strength: (row: T) => number): {tier: string; chatters: number; strength: number}[] {
    const groups = new Map<string, {tier: string; chatters: number; strength: number}>();
    for (const row of rows) {
        const g = groups.get(row.tier) ?? {tier: row.tier, chatters: 0, strength: 0};
        g.chatters += 1;
        g.strength += strength(row);
        groups.set(row.tier, g);
    }
    // pandas groupby sorts the keys.
    return [...groups.values()].sort((a, b) => (a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0));
}

// ---------------------------------------------------------------- Hub 2

export interface CapacityChatter {
    chatter: string;
    firstNameKey: string;
    tier: string;
    skillGrade: number;
    chatQuality: number;
    activityBehaviour: number;
    weeklyCapacityHours: number;
    scheduledHours: number;
    capacityGapHours: number;
    utilizationPct: number;
    qualityAdjustedCapacity: number;
    qualityAdjustedScheduled: number;
    revenue: number;
    revPerHour: number;
    notionTier: string;
    team: string;
    hrProfileFound: boolean;
    scorePending: boolean;
    capacityMissing: boolean;
    capacitySource: string;
    latestGradeDate: string | null;
}

export interface CapacityWeek extends HubWeek {
    scheduledStrength: number;
    capacityHours: number;
    capacityMissingChatters: number;
    utilizationPct: number;
}

export interface Hub2Filters {
    team: string;
    tier: string;
    score: string;
}

export function buildHub2(input: {
    end: IsoDate; weekStart: string; roster: RosterRow[]; shifts: HubShift[]; revenue: HubRevenue[]; scheduled: HubScheduled[];
    tiers: ReturnType<typeof officialTiers>; filters?: Hub2Filters;
}) {
    const capacityRoster = input.roster.filter(r => r.status.toLowerCase() === '' || r.status.toLowerCase() === 'active');
    const weeks: CapacityWeek[] = [];
    let current: CapacityChatter[] = [];
    let currentCreators: CreatorRequirement[] = [];
    for (const w of weekWindows(input.end, input.weekStart)) {
        const hours = hoursByChatter(inPeriod(input.shifts, w.start, w.end));
        const revenueRows = inPeriod(input.revenue, w.start, w.end);
        const revenue = revenueByChatter(revenueRows);
        const revenueByProfile = new Map<string, number>();
        for (const [chatter, amount] of revenue) {
            const key = firstNameKey(chatter);
            revenueByProfile.set(key, (revenueByProfile.get(key) ?? 0) + amount);
        }
        // Planned hours: once per chatter and day (the daily maximum).
        const scheduledRows = inPeriod(input.scheduled, w.start, w.end);
        const dailyMax = new Map<string, number>();
        for (const s of scheduledRows) {
            const key = firstNameKey(s.chatter);
            if (!key) continue;
            const k = `${key}\u0000${s.date}`;
            dailyMax.set(k, Math.max(dailyMax.get(k) ?? -Infinity, s.hours));
        }
        const scheduledCapacity = new Map<string, number>();
        for (const [k, h] of dailyMax) {
            const key = k.split('\u0000')[0];
            scheduledCapacity.set(key, (scheduledCapacity.get(key) ?? 0) + h);
        }

        // Everyone who worked, was scheduled or earned revenue (first chatter per first name).
        // pandas groups chatters in sorted order, so the first name of a shared
        // first-name key is the alphabetically first chatter.
        const sorted = (names: Iterable<string>) => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const people = new Map<string, string>();
        for (const chatter of sorted(hours.keys())) if (!people.has(firstNameKey(chatter))) people.set(firstNameKey(chatter), chatter);
        for (const s of scheduledRows) if (!people.has(firstNameKey(s.chatter))) people.set(firstNameKey(s.chatter), s.chatter ?? '');
        for (const chatter of sorted(revenue.keys())) if (!people.has(firstNameKey(chatter))) people.set(firstNameKey(chatter), chatter);

        let active: RosterRow[] = [...capacityRoster];
        const activeKeys = new Set(active.map(r => r.firstNameKey));
        for (const [key, chatter] of people) {
            if (activeKeys.has(key)) continue;
            const known = input.roster.find(r => r.firstNameKey === key);
            if (known) {
                active.push(known);
            } else {
                active.push({
                    name: chatter, firstNameKey: key, status: 'Missing HR profile', team: 'Unknown', currentTier: 'Unassigned',
                    chattingQuality: 0, activityBehaviour: 0, skillGrade: 0, skillTier: 'Pending score', weeklyCapacityHours: 0,
                    latestGradeDate: null, hrMatch: false, scorePending: true,
                });
            }
        }
        // Filters apply before totals so every card describes the same chatters.
        const f = input.filters;
        if (f?.team) active = active.filter(r => r.team.toLowerCase() === f.team.toLowerCase());
        if (f?.tier) active = active.filter(r => (r.scorePending ? 'Pending score' : r.skillTier).toLowerCase() === f.tier.toLowerCase());
        if (f?.score.toLowerCase() === 'graded') active = active.filter(r => !r.scorePending);
        else if (f?.score.toLowerCase() === 'pending') active = active.filter(r => r.scorePending);

        // Left join with worked hours on first name (several chatters may share one).
        const hoursByKey = new Map<string, {chatter: string; hours: number}[]>();
        for (const [chatter, h] of [...hours].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
            const key = firstNameKey(chatter);
            hoursByKey.set(key, [...(hoursByKey.get(key) ?? []), {chatter, hours: h}]);
        }
        const rows: CapacityChatter[] = [];
        for (const r of active) {
            const matches = hoursByKey.get(r.firstNameKey) ?? [null];
            for (const m of matches) {
                const scheduled = scheduledCapacity.get(r.firstNameKey);
                const capacity = scheduled !== undefined ? scheduled : r.weeklyCapacityHours;
                const workedHours = m?.hours ?? 0;
                const chatterRevenue = revenueByProfile.get(r.firstNameKey) ?? 0;
                rows.push({
                    chatter: m?.chatter ?? r.name,
                    firstNameKey: r.firstNameKey,
                    tier: r.scorePending ? 'Pending score' : r.skillTier,
                    skillGrade: r.skillGrade,
                    chatQuality: r.chattingQuality,
                    activityBehaviour: r.activityBehaviour,
                    weeklyCapacityHours: capacity,
                    scheduledHours: workedHours,
                    capacityGapHours: capacity - workedHours,
                    utilizationPct: capacity ? workedHours / capacity * 100 : 0,
                    qualityAdjustedCapacity: capacity * r.skillGrade / 100,
                    qualityAdjustedScheduled: workedHours * r.skillGrade / 100,
                    revenue: chatterRevenue,
                    revPerHour: workedHours ? chatterRevenue / workedHours : 0,
                    notionTier: r.currentTier,
                    team: r.team,
                    hrProfileFound: r.hrMatch,
                    scorePending: r.scorePending,
                    capacityMissing: capacity <= 0,
                    capacitySource: scheduled !== undefined ? 'RevenueCatcher schedule' : 'Profile capacity',
                    latestGradeDate: r.latestGradeDate,
                });
            }
        }
        const creators = creatorRequirements(revenueRows, input.tiers);
        const sum = (key: keyof CapacityChatter) => rows.reduce((s, r) => s + (r[key] as number), 0);
        const strength = sum('qualityAdjustedCapacity');
        const requirement = creators.reduce((s, c) => s + c.requiredWeeklyHours, 0);
        const capacityTotal = sum('weeklyCapacityHours');
        const hoursTotal = sum('scheduledHours');
        const revenueTotal = sum('revenue');
        const worked = rows.filter(r => r.scheduledHours > 0);
        weeks.push({
            week: w.label, start: w.start, end: w.end, teamStrength: strength, scheduledStrength: sum('qualityAdjustedScheduled'),
            modelRequirement: requirement, gap: strength - requirement, capacityHours: capacityTotal,
            scheduledChatters: new Set(worked.map(r => r.firstNameKey)).size, hours: hoursTotal, revenue: revenueTotal,
            revenuePerHour: hoursTotal ? revenueTotal / hoursTotal : 0,
            hrMatchedChatters: worked.filter(r => r.hrProfileFound).length,
            capacityMissingChatters: rows.filter(r => r.capacityMissing).length,
            utilizationPct: capacityTotal ? hoursTotal / capacityTotal * 100 : 0,
        });
        current = rows;
        currentCreators = creators;
    }
    current = [...current].sort((a, b) => (b.qualityAdjustedCapacity - a.qualityAdjustedCapacity) || (b.scheduledHours - a.scheduledHours)
        || (a.chatter < b.chatter ? -1 : a.chatter > b.chatter ? 1 : 0));
    return {weeks, current, tierMix: tierMix(current, c => c.qualityAdjustedCapacity), creators: currentCreators};
}
