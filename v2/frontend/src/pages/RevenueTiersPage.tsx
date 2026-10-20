import {useRevenueTiers, type RevenueTiersData} from '../api/pages';
import {ColumnChart, DonutChart} from '../components/CHubCharts';
import {DataTable} from '../components/DataTable';
import {ComparisonContext, FilterBar} from '../components/FilterBar';
import {KpiCard} from '../components/KpiCard';
import {fmtMoney, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';
import {pythonColumns, type Cell} from '../lib/pythonTable';

// /revenue-tiers (Python app: revenue_tiers): each model's tips + messages
// pace per day, week and month, and the tier it reaches.

const HREF = '/revenue-tiers';
type Assignment = RevenueTiersData['assignments']['weekly'][number];

function Table<Row>({rows, defs, money}: {rows: Row[]; defs: [string, (row: Row) => Cell][]; money: MoneyContext}) {
    if (!rows.length) return <div className="empty">No rows for the selected filters.</div>;
    return <DataTable rows={rows} columns={pythonColumns(defs, money)}/>;
}

const ASSIGNMENT_DEFS: [string, (row: Assignment) => Cell][] = [
    ['cadence', r => r.cadence], ['tier', r => r.tier], ['model', r => r.model], ['tier_revenue', r => r.tier_revenue],
    ['selected_revenue', r => r.selected_revenue], ['active_days', r => r.active_days], ['transactions', r => r.transactions],
];

const codePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Python: tier_roster, the weekly models per tier.
function TierRoster({rows}: {rows: Assignment[]}) {
    if (!rows.length) return <div className="tier-roster empty">No tier assignments for this date range.</div>;
    const sorted = [...rows].sort((a, b) => codePoint(a.tier, b.tier) || b.tier_revenue - a.tier_revenue || codePoint(a.model, b.model));
    return (
        <div className="tier-roster">
            {['Tier A', 'Tier B', 'Tier C'].map(tier => {
                const names = sorted.filter(r => r.tier === tier && r.model.trim());
                return (
                    <div key={tier} className="tier-roster-card">
                        <h3>{tier}</h3>
                        <ol>{names.length ? names.map((r, i) => <li key={`${r.model}-${i}`}>{r.model}</li>) : <li className="muted">No models</li>}</ol>
                    </div>
                );
            })}
        </div>
    );
}

export function RevenueTiersPage() {
    const [query, setQuery] = usePageQuery('Today');
    const {data, error, isFetching} = useRevenueTiers(query);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    const count = (tier: string) => String(data.byModel.filter(m => m.weekly_tier === tier).length);
    const total = data.byModel.reduce((sum, m) => sum + m.selected_revenue, 0);
    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <FilterBar query={query} options={data.filterOptions} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            <section className="panel tier-note">
                <strong>Tier guide:</strong> Based on tips + messages only. Daily A starts at EUR 1,430, weekly A starts at EUR 10,000, and monthly A starts at EUR 40,000.
                The page converts the selected date range into daily, weekly, and monthly pace so every model is recorded by tier. Revenue tiers are using detailed
                database tip and message revenue rows for this date range.
            </section>
            <section className="kpi-grid">
                <KpiCard label="Tier Revenue" value={fmtMoney(total, money)} note={`tips + messages only, ${data.days} days`}/>
                <KpiCard label="Weekly Tier A" value={count('A')} note="models pacing at EUR 10k+"/>
                <KpiCard label="Weekly Tier B" value={count('B')} note="models pacing EUR 5k-10k"/>
                <KpiCard label="Weekly Tier C" value={count('C')} note="models below EUR 5k"/>
                <KpiCard label="Top Model Pace" value={data.byModel[0]?.model ?? 'n/a'} note="ranked by weekly revenue pace"/>
            </section>
            <section className="grid-2">
                <article className="panel c-chart-card tier-mix-panel"><h2>Weekly Tier Mix</h2>
                    <div className="tier-mix-content">
                        <DonutChart rows={data.weeklyMix.map(m => ({label: m.tier, value: m.models}))} href={HREF}/>
                        <TierRoster rows={data.assignments.weekly}/>
                    </div>
                </article>
                <article className="panel c-chart-card"><h2>Top Weekly Model Pace</h2>
                    <ColumnChart rows={data.topModels.map(m => ({label: m.model, value: m.weekly_revenue}))} href={HREF} format={v => fmtMoney(v, money)} limit={12}/>
                </article>
            </section>
            <section className="grid-2">
                <article className="panel"><h2>Tier Thresholds</h2>
                    <Table rows={data.thresholds} money={money} defs={[['cadence', r => r.cadence], ['tier', r => r.tier], ['range', r => r.range]]}/>
                </article>
                <article className="panel"><h2>Tier Summary</h2>
                    <Table rows={data.tierSummary} money={money} defs={[
                        ['cadence', r => r.cadence], ['tier', r => r.tier], ['range', r => r.range], ['models', r => r.models],
                        ['revenue', r => r.revenue], ['avg_model_revenue', r => r.avg_model_revenue],
                    ]}/>
                </article>
            </section>
            <section className="grid-3">
                <article className="panel"><h2>Daily Model Assignments</h2><Table rows={data.assignments.daily} defs={ASSIGNMENT_DEFS} money={money}/></article>
                <article className="panel"><h2>Weekly Model Assignments</h2><Table rows={data.assignments.weekly} defs={ASSIGNMENT_DEFS} money={money}/></article>
                <article className="panel"><h2>Monthly Model Assignments</h2><Table rows={data.assignments.monthly} defs={ASSIGNMENT_DEFS} money={money}/></article>
            </section>
            <section className="panel"><h2>Model Revenue Tiers</h2>
                <Table rows={data.byModel} money={money} defs={[
                    ['model', r => r.model], ['selected_revenue', r => r.selected_revenue], ['active_days', r => r.active_days], ['transactions', r => r.transactions],
                    ['daily_revenue', r => r.daily_revenue], ['weekly_revenue', r => r.weekly_revenue], ['monthly_revenue', r => r.monthly_revenue],
                    ['daily_tier', r => r.daily_tier], ['weekly_tier', r => r.weekly_tier], ['monthly_tier', r => r.monthly_tier],
                ]}/>
            </section>
        </div>
    );
}
