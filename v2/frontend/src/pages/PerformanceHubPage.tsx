import {usePerformanceHub, type PerformanceHubData} from '../api/pages';
import {ColumnChart, DonutChart, HorizontalChart, StatStrip, StrengthRequirementChart} from '../components/CHubCharts';
import {ScheduledChatterCards} from '../components/ChatterCards';
import {DataTable} from '../components/DataTable';
import {ComparisonContext, DateBar} from '../components/FilterBar';
import {fmtCompact, fmtMoney, pyFixed, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';
import {pythonColumns} from '../lib/pythonTable';

// /c-hub/performance (Python app: c_hub_performance): team strength (skill
// grade x worked hours) against model requirement over four reporting weeks.

// This page always shows euros (the Python app sets no display currency here).
const EUR: MoneyContext = {currency: 'EUR', eurUsdRate: 1};
const HREF = '/c-hub/performance';

export function RequirementTable({rows, hoursColumn}: {rows: PerformanceHubData['creators']; hoursColumn: boolean}) {
    return (
        <DataTable rows={rows.slice(0, 25)} columns={pythonColumns<PerformanceHubData['creators'][number]>([
            ['creator', r => r.creator], ['creator_id', r => r.creatorId], ['revenue', r => r.revenue], ['model_tier', r => r.modelTier],
            hoursColumn ? ['required_weekly_hours', r => r.requiredWeeklyHours] : ['requirement', r => r.requirement],
            ['model_tier_source', r => r.modelTierSource],
        ], EUR)}/>
    );
}

export function TransitionTable({rows}: {rows: PerformanceHubData['transition']}) {
    if (!rows.length) return <div className="empty">No rows for the selected filters.</div>;
    return (
        <DataTable rows={rows.slice(0, 25)} columns={pythonColumns<PerformanceHubData['transition'][number]>([
            ['chatter', r => r.chatter], ['status', r => r.status], ['team', r => r.team], ['tier', r => r.tier], ['skill_grade', r => r.skillGrade],
        ], EUR)}/>
    );
}

export function PerformanceHubPage() {
    const [query, setQuery] = usePageQuery('This month');
    const {data, error, isFetching} = usePerformanceHub(query);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const latest = data.weeks[data.weeks.length - 1];
    const previous = data.weeks.length > 1 ? data.weeks[data.weeks.length - 2] : null;
    const strength = latest?.teamStrength ?? 0;
    const requirement = latest?.modelRequirement ?? 0;
    const gap = strength - requirement;
    const hours = latest?.hours ?? 0;
    const revenue = latest?.revenue ?? 0;
    const chatters = latest?.scheduledChatters ?? 0;
    const matched = latest?.hrMatchedChatters ?? 0;
    const strengthChange = strength - (previous?.teamStrength ?? 0);
    const requirementChange = requirement - (previous?.modelRequirement ?? 0);
    const chatterChange = chatters - (previous?.scheduledChatters ?? 0);
    const sign = (v: number) => (v >= 0 ? '+' : '');
    const momentum = chatterChange > 0 ? 'Stronger' : chatterChange < 0 ? 'Weaker' : 'Stable';
    const momentumNote = `${fmtCompact(chatterChange, sign(chatterChange))} scheduled vs previous week`;
    const matchNote = chatters ? `${matched}/${chatters} scheduled chatters matched to HR` : 'no scheduled chatters';
    const revPerHour = hours ? fmtMoney(revenue / hours, EUR) : 'n/a';

    const insights: [string, string][] = [
        [`Current team strength is ${fmtCompact(strength)} against a model requirement of ${fmtCompact(requirement)}.`, gap >= 0 ? 'positive' : 'warning'],
        [`Strength moved ${fmtCompact(strengthChange, sign(strengthChange))} vs the previous week.`, strengthChange >= 0 ? 'positive' : 'warning'],
        [`Model requirement moved ${fmtCompact(requirementChange, sign(requirementChange))} vs the previous week.`, 'neutral'],
        [`Chatter capacity is ${momentum.toLowerCase()}: ${momentumNote}, with ${fmtCompact(data.transition.length)} people in HR transition/watch.`,
            chatterChange > 0 ? 'positive' : chatterChange < 0 ? 'warning' : 'neutral'],
        [`HR match coverage: ${matchNote}. Missing HR scores stay pending and do not add strength yet.`, chatters && matched < chatters ? 'warning' : 'positive'],
        [`Current week revenue per scheduled hour is ${revPerHour}.`, 'neutral'],
    ];
    const tiles: [string, string, string][] = [
        ['Team Strength', fmtCompact(strength), 'skill grade x scheduled hours'],
        ['Operating Potential', requirement ? `${pyFixed(strength / requirement * 100, 1)}%` : 'n/a', 'strength vs model requirement'],
        ['Model Requirement', fmtCompact(requirement), 'RevenueCatcher creator tiers'],
        ['Capacity Gap', fmtCompact(gap, sign(gap)), 'strength minus requirement'],
        ['Hiring Signal', momentum, momentumNote],
        ['Scheduled Chatters', fmtCompact(chatters), 'unknown shifts excluded'],
        ['Scheduled Hours', fmtCompact(hours), 'counted from shifts'],
        ['HR Profiles', matchNote, 'Notion match coverage'],
        ['Rev / Hour', revPerHour, 'current week'],
    ];

    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <DateBar query={query} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.comparePeriod.compareStart} compareEnd={data.comparePeriod.compareEnd}
                               currentRevenue={null} previousRevenue={null} money={EUR}/>
            <div className="c-suite-page">
                <section className="notice compact-source">
                    <strong>Performance Hub draft:</strong> Only chatters found in the schedule are counted. HR data is using {data.hrSource} ({data.hrRows} chatter
                    rows). Model requirement uses each creator&apos;s official RevenueCatcher tier badge when available; revenue-based tiers are only a fallback.
                </section>
                <StatStrip tiles={tiles}/>
                <section className="c-hub-grid performance-hub-grid">
                    <article className="panel c-chart-card c-wide-card">
                        <h2>Team Strength vs Model Requirement</h2>
                        <p className="panel-note">Team strength is skill grade x scheduled hours. Model requirement is weekly coverage points from RevenueCatcher creator tier.</p>
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
                        <h2>Strength Leaderboard</h2>
                        <HorizontalChart rows={data.current.map(c => ({label: c.chatter, value: c.operatingPotential}))} href={HREF} limit={12}/>
                    </article>
                    <article className="panel c-chart-card">
                        <h2>Revenue / Hour Trend</h2>
                        <ColumnChart rows={data.weeks.map(w => ({label: w.week, value: w.revenuePerHour}))} href={HREF} format={v => fmtMoney(v, EUR)} limit={4}/>
                    </article>
                    <article className="panel c-chart-card c-wide-card scheduled-chatter-panel">
                        <h2>Chatter Performance Hub</h2>
                        <p className="panel-note">Chat Quality and Activity / Behaviour are the two scoring categories used in each chatter&apos;s skill grade.</p>
                        <ScheduledChatterCards rows={data.current} money={EUR}/>
                    </article>
                    <article className="panel c-chart-card">
                        <h2>Model Requirement Inputs</h2>
                        <p className="panel-note">Weekly requirement points: Tier A = 4,200, Tier B = 3,000, Tier C = 1,800.</p>
                        <RequirementTable rows={data.creators} hoursColumn={false}/>
                    </article>
                    <article className="panel c-chart-card">
                        <h2>HR Transition Watch</h2>
                        <TransitionTable rows={data.transition}/>
                    </article>
                </section>
            </div>
        </div>
    );
}
