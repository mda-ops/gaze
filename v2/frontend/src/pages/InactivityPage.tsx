import {useLocation} from 'react-router-dom';
import {useInactivity, type InactivityData} from '../api/pages';
import {DataTable, type Column} from '../components/DataTable';
import {ComparisonContext, FilterBar} from '../components/FilterBar';
import {KpiCard} from '../components/KpiCard';
import {fmtMoney, fmtNum, fmtPct, fmtTableNumber, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';

// /inactivity and /c-hub/inactivity (Python app: inactivity): inactivity that
// overlaps worked shifts, priced with the model's revenue per hour.

type ChatterRow = InactivityData['chatters'][number];
type TierRow = InactivityData['tiers'][number];

// "1,605.8h"
function hours(value: number): string {
    return `${fmtNum(value)}h`;
}

// Python: compare_note
function compareNote(current: number, previous: number): string {
    if (!previous) return 'no previous data';
    return `${fmtPct((current - previous) / previous * 100)} vs previous`;
}

function tierColumns(money: MoneyContext): Column<TierRow>[] {
    return [
        {label: 'Creator tier', value: r => r.creatorTier},
        {label: 'Events', value: r => r.events, text: r => fmtTableNumber(r.events)},
        {label: 'Models', value: r => r.models, text: r => fmtTableNumber(r.models)},
        {label: 'Scheduled inactive hours', value: r => r.scheduledHours, text: r => hours(r.scheduledHours)},
        {label: 'Money wasted', value: r => r.moneyWasted, text: r => fmtMoney(r.moneyWasted, money)},
        {label: 'Shift hours', value: r => r.shiftHours, text: r => hours(r.shiftHours)},
        {label: 'Inactivity %', value: r => r.inactivityPct, text: r => `${r.inactivityPct.toFixed(1)}%`},
        {label: 'Avg cost / hour', value: r => r.avgCostPerHour, text: r => fmtTableNumber(r.avgCostPerHour)},
    ];
}

function chatterColumns(money: MoneyContext): Column<ChatterRow>[] {
    return [
        {label: 'Chatter', value: r => r.chatter},
        {label: 'Events', value: r => r.events, text: r => fmtTableNumber(r.events)},
        {label: 'Creators', value: r => r.creators, text: r => fmtTableNumber(r.creators)},
        {label: 'Platforms', value: r => r.platforms},
        {label: 'Peak unread', value: r => r.peakUnread, text: r => fmtTableNumber(r.peakUnread)},
        {label: 'Total hours', value: r => r.totalHours, text: r => hours(r.totalHours)},
        {label: 'Max hours', value: r => r.maxHours, text: r => hours(r.maxHours)},
        {label: 'Money wasted', value: r => r.moneyWasted, text: r => fmtMoney(r.moneyWasted, money)},
        {label: 'Avg cost / hour', value: r => r.avgCostPerHour, text: r => fmtTableNumber(r.avgCostPerHour)},
    ];
}

export function InactivityPage() {
    const {pathname} = useLocation();
    const apiPath = pathname.startsWith('/c-hub') ? '/api/pages/c-hub-inactivity' : '/api/pages/inactivity';
    const [query, setQuery] = usePageQuery('Today');
    const {data, error, isFetching} = useInactivity(apiPath, query);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    const c = data.current;
    const p = data.previous;
    const cards: [string, string, string][] = [
        ['Events', c.events.toLocaleString('en-US'), compareNote(c.events, p.events)],
        ['Peak Unread', c.peakUnread.toLocaleString('en-US'), compareNote(c.peakUnread, p.peakUnread)],
        ['Total Hours', hours(c.totalHours), compareNote(c.totalHours, p.totalHours)],
        ['Money Wasted', fmtMoney(c.moneyWasted, money), compareNote(c.moneyWasted, p.moneyWasted)],
        ['Highest Risk', c.worstChatter ?? 'n/a', fmtMoney(c.worstMoney, money)],
    ];
    const i = data.insights;
    const insights = i ? [
        `${i.topMoney.chatter} has the highest estimated money wasted at ${fmtMoney(i.topMoney.moneyWasted, money)}.`,
        `${i.topUnread.chatter} has the highest peak unread count at ${Math.trunc(i.topUnread.peakUnread).toLocaleString('en-US')}.`,
        `${i.topHours.chatter} has the largest inactivity duration at ${fmtNum(i.topHours.totalHours)} hours.`,
        `Money wasted is ${compareNote(c.moneyWasted, p.moneyWasted)}.`,
    ] : ['No PostgreSQL inactivity episodes were found for the selected filters/date range.'];

    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <FilterBar query={query} options={data.filterOptions} onApply={setQuery} includeTransactionType={false}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            <p><a className="button ghost" href={data.managerUrl} target="_blank" rel="noopener">Open RevenueCatcher Inactivity</a></p>
            <section className="notice compact-source">
                <strong>Money wasted calculation:</strong> only inactivity minutes that overlap a scheduled shift are counted.
                Main formula: scheduled inactive hours x model tips + messages per scheduled hour for the same CET sales interval.
                Per-tier formula: sum each tier's hourly scheduled inactive time x that tier's weighted average model revenue/hour for that CET interval.
                If a model has too little revenue history for the selected period, GAZE uses the RevenueCatcher creator tier as fallback/cap context so the estimate stays realistic.
            </section>
            <section className="kpi-grid">
                {cards.map(([label, value, note]) => <KpiCard key={label} label={label} value={value} note={note}/>)}
            </section>
            <section className="grid-2">
                <div className="panel">
                    <h2>Summary</h2>
                    <p className="answer">
                        This period shows {fmtMoney(c.moneyWasted, money)} in estimated money wasted across {fmtNum(c.totalHours)} scheduled
                        inactivity hours. GAZE recalculates this from the portion of each inactivity episode that overlaps a real shift, then prices it from the
                        model&apos;s selected-period tips + messages per scheduled hour, using the RevenueCatcher creator tier only as a fallback/cap when needed.
                    </p>
                </div>
                <div className="panel">
                    <h2>Insights</h2>
                    <ul className="insight-list">{insights.map(text => <li key={text}>{text}</li>)}</ul>
                </div>
            </section>
            <section className="panel inactivity-board">
                <h2>Tier Computation</h2>
                <DataTable columns={tierColumns(money)} rows={data.tiers}/>
            </section>
            <section className="panel inactivity-board">
                <h2>Inactivity Analysis</h2>
                <DataTable columns={chatterColumns(money)} rows={data.chatters}/>
            </section>
        </div>
    );
}
