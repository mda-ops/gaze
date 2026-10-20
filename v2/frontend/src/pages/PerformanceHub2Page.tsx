import {useEffect, useMemo, useState, type FormEvent} from 'react';
import {useSearchParams} from 'react-router-dom';
import {usePerformanceHub2, type PerformanceHub2Data} from '../api/pages';
import {ColumnChart, DonutChart, HorizontalChart, StatStrip, StrengthRequirementChart} from '../components/CHubCharts';
import {CapacityChatterCards} from '../components/ChatterCards';
import {DataTable} from '../components/DataTable';
import {ComparisonContext, DateBar} from '../components/FilterBar';
import {LuxSelect} from '../components/LuxSelect';
import {fmtNum, pyFixed, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';
import {pythonColumns} from '../lib/pythonTable';
import {RequirementTable, TransitionTable} from './PerformanceHubPage';

// /c-hub/performance-2 (Python app: c_hub_performance_2): planned weekly
// capacity weighted by skill grade, against model coverage hours.

const EUR: MoneyContext = {currency: 'EUR', eurUsdRate: 1};
const HREF = '/c-hub/performance-2';

type Chatter = PerformanceHub2Data['current'][number];

function Filters({teams, tiers, onApply}: {teams: string[]; tiers: string[]; onApply: (values: {team: string; tier: string; score: string}) => void}) {
    const [params] = useSearchParams();
    const current = useMemo(() => ({team: params.get('ph2_team') ?? '', tier: params.get('ph2_tier') ?? '', score: params.get('ph2_score') ?? ''}), [params]);
    const [draft, setDraft] = useState(current);
    useEffect(() => setDraft(current), [current]);
    const opts = (values: string[], blank: string) => [{value: '', label: blank}, ...values.map(v => ({value: v, label: v}))];
    function submit(event: FormEvent) {
        event.preventDefault();
        onApply(draft);
    }
    return (
        <form className="filters performance-hub-filters" onSubmit={submit}>
            <label>Team<LuxSelect options={opts(teams, 'All teams')} value={draft.team} onChange={team => setDraft(d => ({...d, team}))}/></label>
            <label>Tier<LuxSelect options={opts(tiers, 'All tiers')} value={draft.tier} onChange={tier => setDraft(d => ({...d, tier}))}/></label>
            <label>Grade status<LuxSelect options={opts(['graded', 'pending'], 'All grades')} value={draft.score} onChange={score => setDraft(d => ({...d, score}))}/></label>
            <button type="submit">Apply filters</button>
        </form>
    );
}

const DETAIL_COLUMNS = pythonColumns<Chatter>([
    ['chatter', r => r.chatter], ['tier', r => r.tier], ['skill_grade', r => r.skillGrade], ['chat_quality', r => r.chatQuality],
    ['activity_behaviour', r => r.activityBehaviour], ['weekly_capacity_hours', r => r.weeklyCapacityHours], ['scheduled_hours', r => r.scheduledHours],
    ['capacity_gap_hours', r => r.capacityGapHours], ['utilization_pct', r => r.utilizationPct], ['quality_adjusted_capacity', r => r.qualityAdjustedCapacity],
    ['quality_adjusted_scheduled', r => r.qualityAdjustedScheduled], ['revenue', r => r.revenue], ['rev_per_hour', r => r.revPerHour],
    ['notion_tier', r => r.notionTier], ['team', r => r.team], ['hr_profile_found', r => (r.hrProfileFound ? 'True' : 'False')],
    ['score_pending', r => (r.scorePending ? 'True' : 'False')], ['capacity_missing', r => (r.capacityMissing ? 'True' : 'False')],
    ['capacity_source', r => r.capacitySource], ['latest_grade_date', r => r.latestGradeDate ?? ''],
], EUR);

export function PerformanceHub2Page() {
    const [query, setQuery] = usePageQuery('This month');
    const [params, setParams] = useSearchParams();
    const extra = useMemo(() => {
        const search = new URLSearchParams();
        for (const name of ['ph2_team', 'ph2_tier', 'ph2_score']) if (params.get(name)) search.set(name, params.get(name)!);
        return search;
    }, [params]);
    const {data, error, isFetching} = usePerformanceHub2(query, extra);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    function applyFilters(values: {team: string; tier: string; score: string}) {
        const search = new URLSearchParams(params);
        for (const [name, value] of [['ph2_team', values.team], ['ph2_tier', values.tier], ['ph2_score', values.score]]) {
            if (value) search.set(name, value);
            else search.delete(name);
        }
        setParams(search);
    }

    const latest = data.weeks[data.weeks.length - 1];
    const previous = data.weeks.length > 1 ? data.weeks[data.weeks.length - 2] : null;
    const strength = latest?.teamStrength ?? 0;
    const requirement = latest?.modelRequirement ?? 0;
    const gap = strength - requirement;
    const chatters = latest?.scheduledChatters ?? 0;
    const matched = latest?.hrMatchedChatters ?? 0;
    const strengthChange = strength - (previous?.teamStrength ?? 0);
    const coverageNote = chatters ? `${matched} of ${chatters} scheduled chatters have score profiles` : 'no scheduled chatters';
    const tiles: [string, string, string][] = [
        ['Team Strength', `${fmtNum(strength)}h`, 'quality-adjusted weekly capacity'],
        ['Model Requirement', `${fmtNum(requirement)}h`, 'weekly model coverage needed'],
        ['Capacity Gap', `${fmtNum(gap)}h`, gap < 0 ? 'shortage' : 'surplus'],
        ['Operating Potential', requirement ? `${pyFixed(strength / requirement * 100, 1)}%` : 'n/a', 'strength vs requirement'],
        ['Strength Growth', `${fmtNum(strengthChange)}h`, 'vs previous week'],
        ['Weekly Capacity', `${fmtNum(latest?.capacityHours ?? 0)}h`, 'RevenueCatcher planned shifts'],
        ['Chatter Hours', `${fmtNum(latest?.hours ?? 0)}h`, 'unique actual hours worked'],
        ['Utilization', `${fmtNum(latest?.utilizationPct ?? 0)}%`, 'unique chatter hours / capacity'],
        ['HR Data Coverage', coverageNote, `${latest?.capacityMissingChatters ?? 0} missing capacity`],
    ];
    const insights: [string, string][] = [
        [`Quality-adjusted team strength is ${fmtNum(strength)}h against ${fmtNum(requirement)}h of model requirement.`, gap >= 0 ? 'positive' : 'warning'],
        [`Capacity gap is ${fmtNum(gap)}h, so this page now shows staffing shortage/surplus directly.`, gap >= 0 ? 'positive' : 'warning'],
        [`Strength moved ${fmtNum(strengthChange)}h vs the previous week.`, strengthChange >= 0 ? 'positive' : 'warning'],
        [`HR data coverage: ${coverageNote}. Missing weekly capacity is shown as missing and does not add strength.`, chatters && matched < chatters ? 'warning' : 'neutral'],
        [`Quality-adjusted worked strength is ${fmtNum(latest?.scheduledStrength ?? 0)}h from ${fmtNum(latest?.hours ?? 0)} unique chatter hours.`, 'neutral'],
    ];

    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <DateBar query={query} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.comparePeriod.compareStart} compareEnd={data.comparePeriod.compareEnd}
                               currentRevenue={null} previousRevenue={null} money={EUR}/>
            <div className="c-suite-page">
                <Filters teams={data.filterOptions.teams} tiers={data.filterOptions.tiers} onApply={applyFilters}/>
                <section className="notice compact-source">
                    <strong>Performance Hub 2:</strong> Filters apply to chatter capacity, utilization and detail analysis. Chatter Hours count a person&apos;s shift
                    once per day, even when Flow links it to several models. Model requirement remains agency-wide. Detail columns can be sorted by clicking a header.
                </section>
                <article className="panel c-chart-card c-wide-card scheduled-chatter-panel">
                    <h2>Chatter Capacity &amp; Utilization</h2>
                    <CapacityChatterCards rows={data.current} money={EUR}/>
                </article>
                <section className="notice compact-source">
                    <strong>Performance Hub 2 draft:</strong> The original Performance Hub is unchanged. This version uses RevenueCatcher planned shifts for weekly
                    capacity and live RevenueCatcher transactions for revenue, then weights capacity by chatter skill score. Model requirement is shown as weekly
                    coverage hours from model tier.
                </section>
                <StatStrip tiles={tiles}/>
                <section className="c-hub-grid performance-hub-grid">
                    <article className="panel c-chart-card c-wide-card">
                        <h2>Team Strength vs Model Requirement</h2>
                        <p className="panel-note">Team strength is quality-adjusted weekly chatter capacity. Model requirement is weekly model coverage needed.</p>
                        <StrengthRequirementChart weeks={data.weeks}/>
                    </article>
                    <article className="panel c-chart-card c-insights">
                        <h2>Management Notes</h2>
                        <ul className="insight-list">{insights.map(([text, tone]) => <li key={text} className={`insight-${tone}`}>{text}</li>)}</ul>
                    </article>
                    <article className="panel c-chart-card">
                        <h2>Current Chatter Tier Mix</h2>
                        <DonutChart rows={data.tierMix.map(t => ({label: t.tier, value: t.strength}))} href={HREF}/>
                    </article>
                    <article className="panel c-chart-card">
                        <h2>Capacity Leaderboard</h2>
                        <HorizontalChart rows={data.current.map(c => ({label: c.chatter, value: c.qualityAdjustedCapacity}))} href={HREF} format={v => `${fmtNum(v)}h`} limit={12}/>
                    </article>
                    <article className="panel c-chart-card">
                        <h2>Utilization Trend</h2>
                        <ColumnChart rows={data.weeks.map(w => ({label: w.week, value: w.utilizationPct}))} href={HREF} format={v => `${fmtNum(v)}%`} limit={4}/>
                    </article>
                    <article className="panel c-chart-card">
                        <h2>Model Requirement Inputs</h2>
                        <p className="panel-note">Draft weekly coverage targets: Tier A = 168h, Tier B = 112h, Tier C = 56h.</p>
                        <RequirementTable rows={data.creators} hoursColumn={true}/>
                    </article>
                    <article className="panel c-chart-card">
                        <h2>HR Transition Watch</h2>
                        <TransitionTable rows={data.transition}/>
                    </article>
                    <article className="panel c-chart-card c-wide-card">
                        <h2>Sortable Chatter Detail</h2>
                        <p className="panel-note">Click a column heading to sort this complete filtered set.</p>
                        <DataTable columns={DETAIL_COLUMNS} rows={data.current}/>
                    </article>
                </section>
            </div>
        </div>
    );
}
