import type {ReactNode} from 'react';
import {useCoreAnalysis, type CoreAnalysisData, type GroupRow} from '../api/pages';
import {DataTable} from '../components/DataTable';
import {ComparisonContext, FilterBar} from '../components/FilterBar';
import type {MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';
import {pythonColumns, type Cell} from '../lib/pythonTable';

// The Core analysis pages /revenue, /chatters, /creators and /platforms
// (Python app: revenue, chatters, creators, platforms).

// Python: coverage_notice.
const COVERAGE: Record<string, string> = {
    overview: "Revenue totals are loaded from Revenue Catcher's revenue-summary endpoint. Active chatters, active creators, hours, inactivity, concentration, and entity rankings need detailed Revenue Catcher endpoints as well.",
    chatters: 'Chatter rankings need a Revenue Catcher response that includes chatter names and revenue by chatter. The revenue-summary endpoint only gives company totals by revenue type.',
    creators: "Creator rankings need a Revenue Catcher response that includes creator names and revenue by creator. The current revenue-summary response only includes top creator IDs, not names or full creator rows.",
    platforms: 'Platform performance needs revenue rows tagged to real platforms such as F2F, OF, or Kinky. The revenue-summary endpoint only gives total revenue by type.',
};

function CoverageNotice({kind}: {kind: string}) {
    return <section className="notice"><strong>Data coverage note:</strong> {COVERAGE[kind]}</section>;
}

type Def<Row> = [key: string, value: (row: Row) => Cell];

function groupColumns<Row extends GroupRow>(group: string): Def<Row>[] {
    return [
        [group, r => r.key], ['revenue', r => r.revenue], ['hours', r => r.hours], ['messages', r => r.messages], ['inactivity', r => r.inactivity],
        ['transactions', r => r.transactions], ['creators_worked', r => r.creators_worked], ['days', r => r.days],
        ['previous_revenue', r => r.previous_revenue], ['change_amount', r => r.change_amount], ['change_pct', r => r.change_pct],
        ['revenue_per_hour', r => r.revenue_per_hour], ['messages_per_hour', r => r.messages_per_hour], ['revenue_share_pct', r => r.revenue_share_pct],
        ['average_revenue_per_day', r => r.average_revenue_per_day], ['average_transaction_value', r => r.average_transaction_value],
    ];
}

// Python: table_html, which shows "No rows for the selected filters." for an empty frame.
function Table<Row>({rows, defs, money}: {rows: Row[]; defs: Def<Row>[]; money: MoneyContext}) {
    if (!rows.length) return <div className="empty">No rows for the selected filters.</div>;
    return <DataTable rows={rows} columns={pythonColumns(defs, money)}/>;
}

function TypeTable({data, money}: {data: CoreAnalysisData; money: MoneyContext}) {
    return (
        <Table rows={data.revenueByType} money={money} defs={[
            ['transaction_type', r => r.transaction_type], ['revenue', r => r.revenue], ['days', r => r.days], ['rows', r => r.rows],
        ]}/>
    );
}

function CorePage({page, children}: {page: string; children: (data: CoreAnalysisData, money: MoneyContext) => ReactNode}) {
    const [query, setQuery] = usePageQuery('Today');
    const {data, error, isFetching} = useCoreAnalysis(page, query);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <FilterBar query={query} options={data.filterOptions} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            {children(data, money)}
        </div>
    );
}

export function RevenuePage() {
    return (
        <CorePage page="/revenue">
            {(data, money) => (
                <>
                    {(!data.coverage.creator || !data.coverage.chatter) && <CoverageNotice kind="overview"/>}
                    <section className="panel"><h2>Revenue by Type</h2><TypeTable data={data} money={money}/></section>
                    <section className="stacked-panels">
                        <div className="panel"><h2>By Creator</h2>
                            <Table rows={data.coverage.creator ? data.groups.creator! : []} defs={groupColumns('creator')} money={money}/>
                        </div>
                        <div className="panel"><h2>By Chatter</h2>
                            <Table rows={data.coverage.chatter ? data.groups.chatter! : []} defs={groupColumns('chatter')} money={money}/>
                        </div>
                    </section>
                </>
            )}
        </CorePage>
    );
}

type Ranked = GroupRow & {rank: number};

export function ChattersPage() {
    return (
        <CorePage page="/chatters">
            {(data, money) => {
                const rows: Ranked[] = data.coverage.chatter ? data.groups.chatter!.map((r, i) => ({...r, rank: i + 1})) : [];
                return (
                    <>
                        {!data.coverage.chatter && <CoverageNotice kind="chatters"/>}
                        <section className="panel"><h2>Chatter Performance</h2>
                            <Table rows={rows} defs={[['rank', r => r.rank], ...groupColumns<Ranked>('chatter')]} money={money}/>
                        </section>
                        <p className="note">Use revenue/hour, inactivity, and change columns to spot top performers, improvements, declines, high hours with low revenue, and high inactivity.</p>
                    </>
                );
            }}
        </CorePage>
    );
}

type CreatorRow = NonNullable<CoreAnalysisData['creatorExtras']>[number];

export function CreatorsPage() {
    return (
        <CorePage page="/creators">
            {(data, money) => (
                <>
                    {!data.coverage.creator && <CoverageNotice kind="creators"/>}
                    <section className="panel"><h2>Creator Performance</h2>
                        <Table rows={data.coverage.creator ? data.creatorExtras! : []} money={money} defs={[
                            ...groupColumns<CreatorRow>('creator'),
                            ['active_chatters', r => r.active_chatters], ['unlock_revenue', r => r.unlock_revenue], ['tip_revenue', r => r.tip_revenue],
                            ['subscription_revenue', r => r.subscription_revenue], ['revenue_per_chatter', r => r.revenue_per_chatter],
                        ]}/>
                    </section>
                </>
            )}
        </CorePage>
    );
}

export function PlatformsPage() {
    return (
        <CorePage page="/platforms">
            {(data, money) => (
                <>
                    {!data.coverage.platform && <CoverageNotice kind="platforms"/>}
                    <section className="panel"><h2>Platform Performance</h2>
                        <Table rows={data.coverage.platform ? data.groups.platform! : []} defs={groupColumns('platform')} money={money}/>
                    </section>
                    <section className="panel"><h2>Revenue by Type</h2><TypeTable data={data} money={money}/></section>
                </>
            )}
        </CorePage>
    );
}
