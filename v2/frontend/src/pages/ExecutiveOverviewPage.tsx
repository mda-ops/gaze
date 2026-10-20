import {useExecutiveOverview, type ExecutiveOverviewData} from '../api/pages';
import {DataTable, type Column} from '../components/DataTable';
import {ComparisonContext, FilterBar} from '../components/FilterBar';
import {KpiCard} from '../components/KpiCard';
import {TrendChart} from '../components/TrendChart';
import {fmtMoney, fmtNum, fmtPct, fmtTableNumber, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';

// /c-hub/executive-overview (Python app: RevenueAnalyticsHandler.overview).

type TypeRow = ExecutiveOverviewData['revenueByType'][number];

function typeColumns(money: MoneyContext): Column<TypeRow>[] {
    return [
        {label: 'transaction_type', value: r => r.transactionType},
        {label: 'revenue', value: r => r.revenue, text: r => fmtMoney(r.revenue, money)},
        {label: 'days', value: r => r.days, text: r => fmtTableNumber(r.days)},
        {label: 'rows', value: r => r.rows, text: r => fmtTableNumber(r.rows)},
    ];
}

export function ExecutiveOverviewPage() {
    const [query, setQuery] = usePageQuery('Today');
    const {data, error, isFetching} = useExecutiveOverview(query);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    const m = data.metrics;
    const change = fmtPct(m.revenueChangePct);
    const managerNote = 'Flow database · company-cut and settlement rules';
    const cards: [string, string, string][] = [
        ['Total Revenue', fmtMoney(m.totalRevenue, money), `% Δ ${change}`],
        ['Flow Manager Gross', fmtMoney(m.flowManagerGross, money), managerNote],
        ['Flow Manager Net', fmtMoney(m.flowManagerNet, money), managerNote],
        ['Revenue / Hour', fmtMoney(m.revenuePerHour, money), 'selected period'],
        ['Active Chatters', String(m.activeChatters), 'distinct'],
        ['Active Creators', String(m.activeCreators), 'distinct'],
        ['Total Hours', fmtNum(m.totalHours), 'shift hours'],
        ['Total Inactivity', m.totalInactivityMinutes === null ? 'n/a' : fmtNum(m.totalInactivityMinutes / 60), 'inactive hours'],
        ['Median / Chatter', fmtMoney(m.medianPerChatter, money), 'median'],
        ['Avg / Creator', fmtMoney(m.avgPerCreator, money), 'average'],
    ];

    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <FilterBar query={query} options={data.filterOptions} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            <section className="notice compact-source">
                <strong>Flow Manager Gross / Net:</strong> these totals come directly from Flow's company-visible transaction view,
                using its company-cut, refund, chargeback, and settlement rules.
            </section>
            <section className="kpi-grid">
                {cards.map(([label, value, note]) => <KpiCard key={label} label={label} value={value} note={note}/>)}
            </section>
            <TrendChart current={data.trend.current} previous={data.trend.previous} previousLabel={data.trend.previousLabel}
                        start={data.trend.start} today={data.trend.today}/>
            <section className="panel">
                <h2>Revenue by Type</h2>
                <DataTable columns={typeColumns(money)} rows={data.revenueByType}/>
            </section>
        </div>
    );
}
