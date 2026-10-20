import {useTargetMonitoring, type TargetMonitoringData} from '../api/pages';
import {DataTable, type Column} from '../components/DataTable';
import {ComparisonContext, DateBar} from '../components/FilterBar';
import {grouped, pyFixed, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';

// /c-hub/target-monitoring (Python app: c_hub_target_monitoring): each model
// account's daily tips + messages against its Flow target, with an action.

type Row = TargetMonitoringData['rows'][number];

// target_monitoring._money / _pct: always EUR, Python rounding.
const money = (value: number) => `€${grouped(value, 2)}`;
const pct = (value: number) => `${pyFixed(value, 1)}%`;

// The last 14 days when no dates are chosen (Python: date.today() - 14 days).
function lastFourteenDays(today: string): [string, string] {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 14);
    return [d.toISOString().slice(0, 10), today];
}

const COLUMNS: Column<Row>[] = [
    {label: 'Model', value: r => r.model},
    {label: 'Platform', value: r => r.platform},
    {label: 'Current Target', value: r => r.currentTarget || null, text: r => (r.currentTarget ? money(r.currentTarget) : 'Needs Target')},
    {label: 'Hit Days', value: r => r.hitDays},
    {label: 'Hit Rate', value: r => r.hitRate, text: r => pct(r.hitRate)},
    {label: 'Median of Hit Days', value: r => r.medianHitDays, text: r => money(r.medianHitDays)},
    {label: 'Average of Hit Days', value: r => r.averageHitDays, text: r => money(r.averageHitDays)},
    {label: 'Median of All Days', value: r => r.medianAllDays, text: r => money(r.medianAllDays)},
    {label: 'Average of All Days', value: r => r.averageAllDays, text: r => money(r.averageAllDays)},
    {label: 'Action', value: r => r.action},
    {label: 'Suggested Target', value: r => r.suggestedTarget, text: r => money(r.suggestedTarget)},
    {label: 'Suggested Target Median', value: r => r.suggestedTargetMedian, text: r => money(r.suggestedTargetMedian)},
    {label: 'Suggested Target Ave', value: r => r.suggestedTarget, text: r => money(r.suggestedTarget)},
];

export function TargetMonitoringPage() {
    const [query, setQuery] = usePageQuery('Custom', lastFourteenDays);
    const {data, error, isFetching} = useTargetMonitoring(query);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const moneyContext: MoneyContext = {currency: query.currency, eurUsdRate: 1};
    const s = data.summary;
    let note = 'Flow targets are the source of truth for Target Monitoring. GAZE reads the shared target data, reviews the selected period, and suggests target actions; approved target changes should still happen in Flow.';
    if (!data.targetsFound) note += ' Current target rows were not found in the connected database yet, so rows without targets are marked Needs Target.';
    const tiles: [string, string, string][] = [
        ['Models', String(s.models), 'model-platform rows'],
        ['Increase', String(s.increase), '5+ hit days'],
        ['Keep', String(s.keep), '1-4 hit days'],
        ['Decrease', String(s.decrease), '0 hit days'],
        ['Needs Target', String(s.needsTarget), 'missing Flow target'],
        ['Median Hit Rate', pct(s.medianHitRate), 'selected period'],
    ];

    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <DateBar query={query} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.comparePeriod.compareStart} compareEnd={data.comparePeriod.compareEnd}
                               currentRevenue={null} previousRevenue={null} money={moneyContext}/>
            <div className="c-suite-page">
                <section className="notice compact-source tier-matrix-note">{note}</section>
                <section className="c-stat-strip">
                    {tiles.map(([label, value, hint]) => (
                        <div key={label} className="c-stat-tile"><span>{label}</span><strong>{value}</strong><em>{hint}</em></div>
                    ))}
                </section>
                <section className="panel target-monitoring-panel">
                    <div className="panel-heading-row">
                        <div>
                            <h2>Target Monitoring</h2>
                            <p className="note">Hit days compare daily tips + messages revenue against the current Flow target; rows without a saved target use the suggested average as the temporary baseline. Increase means 5+ hit days, Keep means 1-4, Decrease means 0.</p>
                        </div>
                    </div>
                    <DataTable columns={COLUMNS} rows={data.rows}/>
                </section>
            </div>
        </div>
    );
}
