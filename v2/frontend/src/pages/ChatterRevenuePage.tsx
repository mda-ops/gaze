import {useChatterRevenue} from '../api/pages';
import {CardFilterForm, options, useCardFilters, type CardFilterConfig} from '../components/CardFilters';
import {ComparisonContext, DateBar} from '../components/FilterBar';
import {KpiCard} from '../components/KpiCard';
import {PlatformTotals, RevenueCard} from '../components/RevenueCards';
import {fmtMoney, fmtNum, fmtPct, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';

// /c-hub/chatter-revenue (Python app: c_hub_chatter_revenue): tips and
// messages per chatter, split across their platforms.

const FILTERS: CardFilterConfig = {
    lists: ['chatter_name', 'chatter_platform', 'chatter_team', 'chatter_creator', 'chatter_transaction_type'],
    sortParam: 'chatter_sort',
    directionParam: 'chatter_sort_direction',
    defaultSort: 'revenue',
};

const TYPE_LABELS: Record<string, string> = {message: 'Messages', tip: 'Tips'};

export function ChatterRevenuePage() {
    const [query, setQuery] = usePageQuery('Today');
    const filters = useCardFilters(FILTERS);
    const {data, error, isFetching} = useChatterRevenue(query, filters.apiParams);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    const m = data.metrics;
    const o = data.filterOptions;
    const cards: [string, string, string][] = [
        ['Total Revenue', fmtMoney(m.totalRevenue, money), `% Δ ${fmtPct(m.revenueChangePct)}`],
        ['Active Chatters', String(m.activeChatters), 'distinct'],
        ['Avg / Chatter', fmtMoney(m.avgPerChatter, money), 'average'],
        ['Revenue / Hour', fmtMoney(m.revenuePerHour, money), 'selected period'],
        ['Total Hours', fmtNum(m.totalHours), 'shift hours'],
    ];

    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <DateBar query={query} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            <div className="c-suite-page">
                <section className="kpi-grid compact-grid">
                    {cards.map(([label, value, note]) => <KpiCard key={label} label={label} value={value} note={note}/>)}
                </section>
                <section className="model-revenue-section">
                    <div className="panel-heading-row">
                        <div>
                            <h2>Chatter Revenue Across Platforms</h2>
                            <p className="note">Each card shows the chatter's tips + messages for the selected period, split across their assigned platforms.</p>
                        </div>
                    </div>
                    <PlatformTotals totals={data.platformTotals} money={money}/>
                    <CardFilterForm
                        fields={[
                            {param: 'chatter_name', label: 'Chatter', options: options(o.chatter)},
                            {param: 'chatter_platform', label: 'Platform', options: options(o.platform)},
                            {param: 'chatter_team', label: 'Team', options: options(o.team)},
                            {param: 'chatter_creator', label: 'Creator', options: options(o.creator)},
                            {param: 'chatter_transaction_type', label: 'Transaction Type', options: options(o.transaction_type, TYPE_LABELS)},
                        ]}
                        sortOptions={[{value: 'revenue', label: 'Revenue'}, {value: 'chatter', label: 'Chatter Name'}]}
                        state={filters.state}
                        onApply={filters.apply}/>
                    {data.cards.length ? (
                        <section className="model-revenue-grid">
                            {data.cards.map(card => (
                                <RevenueCard key={card.chatter} name={card.chatter} card={card} money={money}
                                             headExtra={card.revenuePerHour === null ? null : `${fmtMoney(card.revenuePerHour, money)}/hr`}/>
                            ))}
                        </section>
                    ) : <div className="empty">No chatter revenue rows for the selected filters.</div>}
                </section>
            </div>
        </div>
    );
}
