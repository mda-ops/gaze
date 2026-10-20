import type {ReactNode} from 'react';
import {useLocation} from 'react-router-dom';
import {useCommissions, type CommissionsData} from '../api/pages';
import {DataTable} from '../components/DataTable';
import {ComparisonContext, FilterBar} from '../components/FilterBar';
import {KpiCard} from '../components/KpiCard';
import {fmtMoney, fmtPct, grouped, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';
import {pythonColumns, type Cell} from '../lib/pythonTable';

// /commissions and /c-hub/commissions (Python app: commissions): chatter
// commission, Flow bonuses, salary, chat-manager cuts, operating expenses and
// the gross/net and P&L tables.

function Panel({title, note, children}: {title: string; note?: ReactNode; children: ReactNode}) {
    return (
        <section className="panel">
            {note ? <div className="panel-heading-row"><div><h2>{title}</h2><p className="note">{note}</p></div></div> : <h2>{title}</h2>}
            {children}
        </section>
    );
}

function Table<Row>({rows, columns, money}: {rows: Row[]; columns: [string, (row: Row) => Cell][]; money: MoneyContext}) {
    return <DataTable columns={pythonColumns(columns, money)} rows={rows}/>;
}

function FinanceCards({ledger, money}: {ledger: CommissionsData['ledger']; money: MoneyContext}) {
    if (!ledger.is_complete) {
        return (
            <section className="notice compact-source">
                <strong>P&amp;L status:</strong> Flow has not supplied classified external revenue splits for this scope, so GAZE keeps the detailed
                costs visible but does not present an unconfirmed P&amp;L.
            </section>
        );
    }
    const completeness = 'complete tracked P&L';
    const cards: [string, string, string, string][] = [
        ['Gross Revenue', fmtMoney(ledger.gross_revenue, money), ledger.source, 'gross_revenue'],
        ['External Revenue Splits', fmtMoney(ledger.external_revenue_splits, money), 'platform, creator, partner, other', 'external_revenue_splits'],
        ['Agency Revenue', fmtMoney(ledger.agency_revenue, money), 'gross less external splits', 'agency_revenue'],
        ['Direct Revenue Costs', fmtMoney(ledger.direct_revenue_costs, money), 'chatter and chat-manager costs', 'direct_revenue_costs'],
        ['Net Revenue', fmtMoney(ledger.net_revenue, money), completeness, 'net_revenue'],
        ['P&L Profit/Loss', fmtMoney(ledger.profit_loss, money), completeness, 'profit_loss'],
        ['Profit Margin', fmtPct(ledger.profit_margin_pct), 'P&L / gross revenue', 'profit_margin'],
    ];
    return (
        <section className="kpi-grid finance-kpi-grid">
            {cards.map(([label, value, note, key]) => <KpiCard key={label} label={label} value={value} note={note} metricKey={key}/>)}
        </section>
    );
}

export function CommissionsPage() {
    const {pathname} = useLocation();
    const apiPath = pathname.startsWith('/c-hub') ? '/api/pages/c-hub-commissions' : '/api/pages/commissions';
    const [query, setQuery] = usePageQuery('Today');
    const {data, error, isFetching} = useCommissions(apiPath, query);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    const c = data.cards;
    const opexNote = `fixed department costs only · €${grouped(c.operatingExpensesEur, 2)} + $${grouped(c.operatingExpensesUsd, 2)}`;
    const kpis: [string, string, string, string | undefined][] = [
        ['Chatter Base Commission', fmtMoney(c.baseCommission, money), 'Flow chatter rates', 'chatter_commission'],
        ['Flow Chatter Bonus', fmtMoney(c.flowBonus, money), 'daily Flow bonus rules', 'chatter_bonus'],
        ['Chatter Commission', fmtMoney(c.preSalaryCommission, money), 'base commission plus Flow bonus', 'chatter_commission'],
        ['Chatter Salary', fmtMoney(c.salaryCost, money), 'recorded salary or plan hourly rate', 'chatter_salary'],
        ['Commission After Salary', fmtMoney(c.postSalaryCommission, money), 'commission less salary cost', undefined],
        ['Chat Manager Cuts', fmtMoney(c.chatManagerCuts, money), "Flow's dated team-manager rate", 'manager_commission'],
        ['Admin & Management Pool', fmtMoney(c.adminManagementPool, money), 'company net less recorded chat-manager cuts', undefined],
        ['Operating Expenses', fmtMoney(c.operatingExpenses, money), opexNote, 'operating_expenses'],
        ['MD Earnings After Expenses', fmtMoney(c.mdEarningsAfterExpenses, money), 'management allocation view; not a P&L', 'md_earnings_after_expenses'],
    ];

    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <FilterBar query={query} options={data.filterOptions} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            <FinanceCards ledger={data.ledger} money={money}/>
            <section className="kpi-grid finance-kpi-grid">
                {kpis.map(([label, value, note, key]) => <KpiCard key={label} label={label} value={value} note={note} metricKey={key}/>)}
            </section>
            <Panel title="Gross and Net Rev Breakdown" note="Gross Rev is total money earned. Net Rev is the MD/company share after tracked RevenueCatcher splits, chatter commission, and manager commission.">
                <Table money={money} rows={data.breakdown} columns={[['line_item', r => r.lineItem], ['amount', r => r.amount], ['share_pct', r => r.sharePct], ['source', r => r.source]]}/>
            </Panel>
            <Panel title="Profit and Loss" note="P&L uses tracked RevenueCatcher split fields first; when they are unavailable, GAZE falls back to the configured commission rules.">
                <Table money={money} rows={data.pnl} columns={[['profit_loss_line', r => r.line], ['amount', r => r.amount]]}/>
            </Panel>
            <Panel title="Chatter Commission by Team" note="Flow's dated chatter rate and team assignment are used first. A Gaze plan is used only when Flow has no rate. Revenue with no attributed chatter is never treated as a payable commission.">
                <Table money={money} rows={data.teams} columns={[
                    ['team', r => r.team], ['base_commission', r => r.baseCommission], ['flow_bonus', r => r.flowBonus],
                    ['pre_salary_commission', r => r.preSalaryCommission], ['salary_cost', r => r.salaryCost], ['post_salary_commission', r => r.postSalaryCommission],
                ]}/>
            </Panel>
            <Panel title="Flow Payout Attribution Audit" note="This separates payable commission from transactions Flow has not attributed. It prevents unassigned revenue from inflating team costs and makes the remaining data fixes explicit.">
                <Table money={money} rows={data.audit} columns={[['status', r => r.status], ['transactions', r => r.transactions], ['revenue', r => r.revenue], ['meaning', r => r.meaning]]}/>
            </Panel>
            <Panel title="Chat Manager Allocation" note="Manager cuts are calculated from Flow's effective-dated team-manager percentage. The Admin & Management Pool is retained company net after those cuts; it is not presented as paid payroll because Flow has no admin-payroll payout record.">
                <Table money={money} rows={data.managers} columns={[
                    ['team', r => r.team], ['chat_manager', r => r.chatManager], ['manager_cut', r => r.managerCut],
                    ['attributed_revenue', r => r.attributedRevenue], ['manager_cut_pct', r => r.managerCutPct],
                ]}/>
            </Panel>
            <Panel title="Department Operating Expenses" note="Monthly personnel costs are shown in their original EUR and USD currencies. Selected-period cost is accrued by actual calendar days and converted to EUR at Flow’s reporting FX rate. English chatter salary is calculated separately at $2 per worked hour; Dutch chatters are commission-only. Maurice is excluded here because he is paid by commission.">
                <Table money={money} rows={data.departments} columns={[
                    ['department', r => r.department], ['monthly_eur', r => r.monthlyEur], ['monthly_usd', r => r.monthlyUsd],
                    ['period_eur', r => r.periodEur], ['period_usd', r => r.periodUsd], ['period_eur_reporting', r => r.periodEurReporting],
                ]}/>
            </Panel>
            <Panel title="Dutch and English Team Costs" note="Total cost includes non-chatter tracked costs, chatter commission before salary, and salary cost. Team rows are always shown separately, even when no revenue is recorded for one team.">
                <Table money={money} rows={data.costTeams} columns={[
                    ['team', r => r.team], ['gross_revenue', r => r.grossRevenue], ['non_chatter_costs', r => r.nonChatterCosts],
                    ['chatter_commission_pre_salary', r => r.preSalary], ['salary_cost', r => r.salaryCost],
                    ['total_cost_including_salary', r => r.totalCost], ['chatter_commission_post_salary', r => r.postSalary],
                ]}/>
            </Panel>
            <Panel title="Chatter Commission Detail">
                <Table money={money} rows={data.chatters} columns={[
                    ['team', r => r.team], ['chatter', r => r.chatter], ['base_commission', r => r.baseCommission], ['commission_plan', r => r.commissionPlan],
                    ['salary_cost', r => r.salaryCost], ['flow_bonus', r => r.flowBonus], ['pre_salary_commission', r => r.preSalaryCommission],
                    ['post_salary_commission', r => r.postSalaryCommission],
                ]}/>
            </Panel>
            {data.creators.length > 0 && (
                <Panel title="Creator Gross and Net Rev">
                    <Table money={money} rows={data.creators} columns={[
                        ['creator', r => r.creator], ['gross_rev', r => r.grossRev], ['net_rev', r => r.netRev], ['creator_share', () => 0],
                        ['partner_share', () => 0], ['other_share', () => 0], ['chatter_commission', () => 0], ['manager_commission', () => 0], ['platform_share', () => 0],
                    ]}/>
                </Panel>
            )}
        </div>
    );
}
