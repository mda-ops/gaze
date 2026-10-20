import {keepPreviousData, useQuery} from '@tanstack/react-query';
import type {ReactNode} from 'react';
import {api} from '../api/client';
import {DonutChart, StatStrip} from '../components/CHubCharts';
import {ComparisonContext, DateBar} from '../components/FilterBar';
import {KpiCard} from '../components/KpiCard';
import {
    Bars, LineChart, SourceNote, TableView, TicketDepartmentChart, TicketStatusDonut,
    type Chart, type SourceNoteData, type Table,
} from '../components/LookerParts';
import {apiQueryString, usePageQuery, type PageQuery} from '../lib/pageQuery';

// The Hub pages and their C Hub versions (Python app: compliance_dash,
// marketing, ..., c_hub_compliance, ...). The server builds the cards and
// charts; these pages lay them out like the Python app.

type Card = [label: string, value: string, note: string];
interface Frame {
    comparePeriod: {compare: string; compareStart: string; compareEnd: string};
}

const EUR = {currency: 'EUR' as const, eurUsdRate: 1};

function useLooker<T>(url: string, query: PageQuery | null) {
    const search = query ? apiQueryString(query) : '';
    return useQuery({
        queryKey: ['looker', url, search],
        queryFn: () => api<T & Frame>(`${url}?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

// The tickets pages open on a fixed custom range (Python app defaults).
const FROM_JAN = (today: string): [string, string] => ['2026-01-01', today];
const FROM_MID_MAY = (today: string): [string, string] => ['2026-05-15', today];

// Date bar and comparison strip (Python: looker_date_bar), then the page;
// C Hub pages are wrapped in .c-suite-page (Python: c_dashboard_page).
function LookerPage<T>({page, cHub, customDefault, api: url = `/api/looker${page}`, children}: {
    page: string;
    cHub: boolean;
    api?: string;
    customDefault?: (today: string) => [string, string];
    children: (data: T) => ReactNode;
}) {
    const [query, setQuery] = usePageQuery(customDefault ? 'Custom' : 'This month', customDefault);
    const {data, error, isFetching} = useLooker<T>(url, query);
    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;
    const body = children(data);
    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <DateBar query={query} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.comparePeriod.compareStart} compareEnd={data.comparePeriod.compareEnd}
                               currentRevenue={null} previousRevenue={null} money={EUR}/>
            {cHub ? <div className="c-suite-page">{body}</div> : body}
        </div>
    );
}

function KpiCards({cards}: {cards: Card[]}) {
    return <section className="kpi-grid">{cards.map(([label, value, note]) => <KpiCard key={label} label={label} value={value} note={note}/>)}</section>;
}

const Panel = ({title, children, className = 'panel'}: {title: string; children: ReactNode; className?: string}) => (
    <div className={className}><h2>{title}</h2>{children}</div>
);

// ---- Hub pages ------------------------------------------------------------

export function ComplianceDashPage() {
    return (
        <LookerPage<{source: SourceNoteData; cards: Card[]; latest: Table; metrics: Table}> page="/compliance-dash" cHub={false}>
            {d => (
                <>
                    <SourceNote source={d.source}/>
                    <KpiCards cards={d.cards}/>
                    <section className="grid-2">
                        <Panel title="Latest Quality Assessment"><TableView table={d.latest}/></Panel>
                        <Panel title="Compliance Metric Definitions"><TableView table={d.metrics}/></Panel>
                    </section>
                </>
            )}
        </LookerPage>
    );
}

export function MarketingPage() {
    return (
        <LookerPage<{source: SourceNoteData; cards: Card[]; adsByPlatform: Table; socialsByModel: Table; fansByModel: Table}> page="/marketing" cHub={false}>
            {d => (
                <>
                    <SourceNote source={d.source}/>
                    <KpiCards cards={d.cards}/>
                    <section className="grid-2">
                        <Panel title="Ads by Platform"><TableView table={d.adsByPlatform}/></Panel>
                        <Panel title="Socials by Model"><TableView table={d.socialsByModel}/></Panel>
                    </section>
                    <section className="panel"><h2>OF New Fans by Model</h2><TableView table={d.fansByModel}/></section>
                </>
            )}
        </LookerPage>
    );
}

export function ModelsSocialsPage() {
    return (
        <LookerPage<{source: SourceNoteData; cards: Card[]; byModel: Table; byPlatform: Table; recent: Table}> page="/models-socials" cHub={false}>
            {d => (
                <>
                    <SourceNote source={d.source}/>
                    <KpiCards cards={d.cards}/>
                    <section className="grid-2">
                        <Panel title="By Model"><TableView table={d.byModel}/></Panel>
                        <Panel title="By Platform"><TableView table={d.byPlatform}/></Panel>
                    </section>
                    <section className="panel"><h2>Recent Source Rows</h2><TableView table={d.recent}/></section>
                </>
            )}
        </LookerPage>
    );
}

export function OfNewFanGrowthPage() {
    return (
        <LookerPage<{source: SourceNoteData; cards: Card[]; byModel: Table; daily: Table}> page="/of-new-fan-growth" cHub={false}>
            {d => (
                <>
                    <SourceNote source={d.source}/>
                    <KpiCards cards={d.cards}/>
                    <section className="grid-2">
                        <Panel title="New Fans by Model"><TableView table={d.byModel}/></Panel>
                        <Panel title="Daily New Fan Growth"><TableView table={d.daily}/></Panel>
                    </section>
                </>
            )}
        </LookerPage>
    );
}

export function AdsPerformancePage() {
    return (
        <LookerPage<{source: SourceNoteData; cards: Card[]; byPlatform: Table; byCampaign: Table; recent: Table}> page="/ads-performance" cHub={false}>
            {d => (
                <>
                    <SourceNote source={d.source}/>
                    <KpiCards cards={d.cards}/>
                    <section className="grid-2">
                        <Panel title="By Platform"><TableView table={d.byPlatform}/></Panel>
                        <Panel title="By Campaign"><TableView table={d.byCampaign}/></Panel>
                    </section>
                    <section className="panel"><h2>Recent Ad Rows</h2><TableView table={d.recent}/></section>
                </>
            )}
        </LookerPage>
    );
}

interface TicketsView {
    cards: Card[];
    byDepartmentStatus: Table;
    byStatus: Table;
    tickets: Table;
}

export function NotionTicketsPage() {
    return (
        <LookerPage<TicketsView & {source: SourceNoteData}> page="/notion-tickets" cHub={false} customDefault={FROM_MID_MAY}>
            {d => (
                <>
                    <SourceNote source={d.source}/>
                    <KpiCards cards={d.cards}/>
                    <section className="grid-2 ticket-dashboard">
                        <Panel title="Tickets by Department" className="panel ticket-visual"><TicketDepartmentChart table={d.byDepartmentStatus}/></Panel>
                        <Panel title="Tickets by Status" className="panel ticket-visual"><TicketStatusDonut table={d.byStatus}/></Panel>
                    </section>
                    <section className="panel ticket-list-panel"><h2>Ticket List</h2><TableView table={d.tickets}/></section>
                </>
            )}
        </LookerPage>
    );
}

// ---- C Hub pages ----------------------------------------------------------

const Article = ({title, children, wide = false, className = ''}: {title: string; children: ReactNode; wide?: boolean; className?: string}) => (
    <article className={['panel c-chart-card', wide && 'c-wide-card', className].filter(Boolean).join(' ')}><h2>{title}</h2>{children}</article>
);

function Notice({label, text}: {label: string; text: string | null}) {
    return text ? <section className="notice compact-source"><strong>{label}</strong> {text}</section> : null;
}

export function CHubCompliancePage() {
    return (
        <LookerPage<{cards: Card[]; bestByPillar: Chart; worstByPillar: Chart; latest: Table}> page="/c-hub/compliance" cHub>
            {d => (
                <>
                    <StatStrip tiles={d.cards}/>
                    <section className="c-hub-grid">
                        <Article title="Compliance Score by Pillar"><Bars chart={d.bestByPillar} href="/compliance-dash" kind="horizontal"/></Article>
                        <Article title="Risk Floor by Pillar"><Bars chart={d.worstByPillar} href="/compliance-dash" kind="column"/></Article>
                        <Article title="Latest Quality Assessment" wide><TableView table={d.latest}/></Article>
                    </section>
                </>
            )}
        </LookerPage>
    );
}

export function CHubMarketingAdsPage() {
    return (
        <LookerPage<{cards: Card[]; notice: string | null; spendByCampaign: Chart; leadsByPlatform: Chart; leadsByCampaign: Chart; cplByCampaign: Chart}>
            page="/c-hub/marketing-ads" cHub>
            {d => (
                <>
                    <StatStrip tiles={d.cards}/>
                    <Notice label="Marketing ads source:" text={d.notice}/>
                    <section className="c-hub-grid">
                        <Article title="Ad Spend by Campaign"><Bars chart={d.spendByCampaign} href="/ads-performance" kind="column"/></Article>
                        <Article title="Leads by Platform"><Bars chart={d.leadsByPlatform} href="/ads-performance" kind="horizontal"/></Article>
                        <Article title="Leads by Campaign"><Bars chart={d.leadsByCampaign} href="/ads-performance" kind="horizontal"/></Article>
                        <Article title="CPL by Campaign"><Bars chart={d.cplByCampaign} href="/ads-performance" kind="column"/></Article>
                    </section>
                </>
            )}
        </LookerPage>
    );
}

export function CHubModelsSocialsPage() {
    return (
        <LookerPage<{cards: Card[]; reachByModel: Chart; visitsByModel: Chart; subscriptionsByModel: Chart; reachByPlatform: Chart}> page="/c-hub/models-socials" cHub>
            {d => (
                <>
                    <StatStrip tiles={d.cards}/>
                    <section className="c-hub-grid">
                        <Article title="Social Traffic / Reach"><Bars chart={d.reachByModel} href="/models-socials" kind="horizontal"/></Article>
                        <Article title="Profile Visits by Model"><Bars chart={d.visitsByModel} href="/models-socials" kind="column"/></Article>
                        <Article title="Subscriptions by Model"><Bars chart={d.subscriptionsByModel} href="/models-socials" kind="column"/></Article>
                        <Article title="Platform Reach Mix"><Bars chart={d.reachByPlatform} href="/models-socials" kind="horizontal"/></Article>
                    </section>
                </>
            )}
        </LookerPage>
    );
}

export function CHubOfNewFansPage() {
    return (
        <LookerPage<{cards: Card[]; lines: {model: string; points: {label: string; value: number}[]}[]; byModel: Chart}> page="/c-hub/of-new-fans" cHub>
            {d => (
                <>
                    <StatStrip tiles={d.cards}/>
                    <section className="c-hub-grid">
                        {d.lines.map(line => (
                            <Article key={line.model} title={`${line.model} New Fans`}><LineChart points={line.points} href="/of-new-fan-growth"/></Article>
                        ))}
                        <Article title="New Fans by Model" wide><Bars chart={d.byModel} href="/of-new-fan-growth" kind="horizontal"/></Article>
                    </section>
                </>
            )}
        </LookerPage>
    );
}

type AdsPerformanceView =
    | {empty: true; cards: Card[]}
    | {empty: false; cards: Card[]; spendByCategory: Chart; leadsByCategory: Chart; cplByCategory: Chart; campaignSpend: Chart};

export function CHubAdsPerformancePage() {
    return (
        <LookerPage<AdsPerformanceView> page="/c-hub/ads-performance" cHub>
            {d => (
                <>
                    <StatStrip tiles={d.cards}/>
                    {!d.empty && (
                        <section className="c-hub-grid">
                            <Article title="Spend by Ad Category"><Bars chart={d.spendByCategory} href="/ads-performance" kind="column"/></Article>
                            <Article title="Leads by Ad Category"><Bars chart={d.leadsByCategory} href="/ads-performance" kind="horizontal"/></Article>
                            <Article title="CPL by Ad Category"><Bars chart={d.cplByCategory} href="/ads-performance" kind="column"/></Article>
                            <Article title="Campaign Spend Ranking"><Bars chart={d.campaignSpend} href="/ads-performance" kind="horizontal"/></Article>
                        </section>
                    )}
                </>
            )}
        </LookerPage>
    );
}

export function CHubTicketsPage() {
    return (
        <LookerPage<TicketsView & {notice: string | null}> page="/c-hub/tickets" cHub customDefault={FROM_JAN}>
            {d => (
                <>
                    <StatStrip tiles={d.cards}/>
                    <Notice label="Ticket source:" text={d.notice}/>
                    <section className="c-hub-grid ticket-dashboard">
                        <Article title="Tickets by Department"><TicketDepartmentChart table={d.byDepartmentStatus}/></Article>
                        <Article title="Tickets by Status"><TicketStatusDonut table={d.byStatus}/></Article>
                        <Article title="Ticket List" wide className="ticket-list-panel"><TableView table={d.tickets}/></Article>
                    </section>
                </>
            )}
        </LookerPage>
    );
}

// ---- /c-hub: Marketing & Operations Overview (Python app: c_hub) ----------

interface OverviewView {
    links: Record<'socials' | 'ads' | 'fans' | 'tickets' | 'compliance' | 'inactivity', string>;
    cards: {label: string; value: string; note: string; href: string; deltaClass: string}[];
    topSocialReach: Chart;
    adSpend: Chart;
    ticketStatus: Table;
    newFans: Chart;
    complianceScores: Chart;
    insights: string[];
}

function LinkedArticle({title, href, linkText, children}: {title: string; href: string; linkText: string; children: ReactNode}) {
    return <article className="panel c-chart-card"><a className="panel-link" href={href}>{linkText}</a><h2>{title}</h2>{children}</article>;
}

export function CHubOverviewPage() {
    return (
        <LookerPage<OverviewView> page="/c-hub" cHub={false} api="/api/pages/c-hub">
            {d => (
                <>
                    <section className="notice compact-source">
                        <strong>Live C-level view:</strong> Marketing, Ads, OF Fan Growth, Compliance, Tickets, and Inactivity are combined from the Hub sources
                        already connected to GAZE.
                    </section>
                    <section className="c-hero">
                        <div><span>Marketing &amp; operations overview</span><h2>What moved, what matters, and where to click next.</h2></div>
                    </section>
                    <section className="c-metric-grid">
                        {d.cards.map(c => (
                            <a key={c.label} className="c-metric-card" href={c.href}><span>{c.label}</span><strong>{c.value}</strong><em className={c.deltaClass}>{c.note}</em></a>
                        ))}
                    </section>
                    <section className="c-hub-grid">
                        <LinkedArticle title="Top Social Reach" href={d.links.socials} linkText="Open Models Socials">
                            <Bars chart={d.topSocialReach} href={d.links.socials} kind="horizontal"/>
                        </LinkedArticle>
                        <LinkedArticle title="BD Ad Spend" href={d.links.ads} linkText="Open Ads"><Bars chart={d.adSpend} href={d.links.ads} kind="column"/></LinkedArticle>
                        <LinkedArticle title="Ticket Status Mix" href={d.links.tickets} linkText="Open Tickets">
                            <DonutChart rows={d.ticketStatus.rows.map(r => ({label: String(r[0]), value: Number(r[1])}))} href={d.links.tickets}/>
                        </LinkedArticle>
                        <LinkedArticle title="OF New Fan Growth" href={d.links.fans} linkText="Open OF Fans"><Bars chart={d.newFans} href={d.links.fans} kind="column"/></LinkedArticle>
                        <LinkedArticle title="Compliance Quality Scores" href={d.links.compliance} linkText="Open Compliance">
                            <Bars chart={d.complianceScores} href={d.links.compliance} kind="horizontal"/>
                        </LinkedArticle>
                        <article className="panel c-chart-card c-insights">
                            <h2>Executive Insights</h2>
                            <ul className="insight-list">{d.insights.map(text => <li key={text} className="insight-neutral">{text}</li>)}</ul>
                        </article>
                    </section>
                </>
            )}
        </LookerPage>
    );
}
