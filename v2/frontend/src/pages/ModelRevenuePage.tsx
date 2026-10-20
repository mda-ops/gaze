import {useModelRevenue} from '../api/pages';
import {CardFilterForm, options, useCardFilters, type CardFilterConfig} from '../components/CardFilters';
import {ComparisonContext, DateBar} from '../components/FilterBar';
import {PlatformTotals, RevenueCard} from '../components/RevenueCards';
import {TrendChart} from '../components/TrendChart';
import type {MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';

// /c-hub/revenue (Python app: c_hub_revenue): one card per model with its
// revenue per platform, plus platform totals and the month-to-date trend.

const FILTERS: CardFilterConfig = {
    lists: ['model_creator', 'model_platform', 'model_agency', 'model_team', 'model_transaction_type'],
    sortParam: 'model_sort',
    directionParam: 'model_sort_direction',
    defaultSort: 'revenue',
};

const TYPE_LABELS: Record<string, string> = {message: 'Messages', tip: 'Tips', subscription: 'Subscriptions', ppv: 'PPV'};

export function ModelRevenuePage() {
    const [query, setQuery] = usePageQuery('Today');
    const filters = useCardFilters(FILTERS);
    const {data, error, isFetching} = useModelRevenue(query, filters.apiParams);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    const o = data.filterOptions;

    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <DateBar query={query} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            <div className="c-suite-page">
                <section className="model-revenue-section">
                    <PlatformTotals totals={data.platformTotals} money={money}/>
                    <CardFilterForm
                        fields={[
                            {param: 'model_creator', label: 'Creator', options: options(o.creator)},
                            {param: 'model_platform', label: 'Platform', options: options(o.platform)},
                            {param: 'model_agency', label: 'Agency', options: options(o.agency)},
                            {param: 'model_team', label: 'Team', options: options(o.team)},
                            {param: 'model_transaction_type', label: 'Transaction Type', options: options(o.transaction_type, TYPE_LABELS)},
                        ]}
                        sortOptions={[{value: 'revenue', label: 'Revenue'}, {value: 'subscriptions', label: 'Subscription Revenue'}, {value: 'model', label: 'Model Name'}]}
                        state={filters.state}
                        onApply={filters.apply}/>
                    {data.cards.length ? (
                        <section className="model-revenue-grid">
                            {data.cards.map(card => <RevenueCard key={card.model} name={card.model} card={card} money={money}/>)}
                        </section>
                    ) : <div className="empty">No model revenue rows for the selected filters.</div>}
                </section>
                <TrendChart current={data.trend.current} previous={data.trend.previous} previousLabel={data.trend.previousLabel}
                            start={data.trend.start} today={data.trend.today}/>
            </div>
        </div>
    );
}
