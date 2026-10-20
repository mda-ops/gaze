import {useInsights} from '../api/pages';
import {ComparisonContext, FilterBar} from '../components/FilterBar';
import type {MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';

// /insights (Python app: insights): fixed sentences about the period and
// groups whose revenue moved past the anomaly thresholds in Settings.

export function InsightsPage() {
    const [query, setQuery] = usePageQuery('Today');
    const {data, error, isFetching} = useInsights(query);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <FilterBar query={query} options={data.filterOptions} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            <section className="panel"><h2>Deterministic Insights</h2><ul>{data.facts.map(f => <li key={f}>{f}</li>)}</ul></section>
            <section className="panel"><h2>Anomaly Flags</h2>
                {data.flags.length ? data.flags.map((f, i) => (
                    <p key={i}><strong>{f.area} - {f.name}:</strong> {f.message}<br/><span>{f.why}</span></p>
                )) : <p>No anomalies flagged.</p>}
            </section>
        </div>
    );
}
