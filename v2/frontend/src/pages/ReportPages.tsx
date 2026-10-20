import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {api} from '../api/client';
import {ComparisonContext, FilterBar} from '../components/FilterBar';
import type {MoneyContext} from '../lib/format';
import {apiQueryString, usePageQuery, type FilterField} from '../lib/pageQuery';

// /weekly-report and /monthly-report (Python app: weekly_report_page,
// monthly_report_page): the management summary and the full report text.

interface ReportData {
    period: {start: string; end: string; compare: string; compareStart: string; compareEnd: string};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    managementSummary: string;
    report: string;
    filterOptions: Record<FilterField, string[]>;
}

function ReportPage({kind}: {kind: 'weekly' | 'monthly'}) {
    // Python: report_context, last week for the weekly report, this month for the monthly.
    const [query, setQuery] = usePageQuery(kind === 'weekly' ? 'Last week' : 'This month');
    const search = query ? apiQueryString(query) : '';
    const {data, error, isFetching} = useQuery({
        queryKey: ['report', kind, search],
        queryFn: () => api<ReportData>(`/api/pages/${kind}-report?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <FilterBar query={query} options={data.filterOptions} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            <section className="panel"><h2>Management Summary</h2><pre className="report">{data.managementSummary}</pre></section>
            <section className="panel"><h2>{kind === 'weekly' ? 'Weekly Report' : 'Monthly Report'}</h2><pre className="report">{data.report}</pre></section>
        </div>
    );
}

export const WeeklyReportPage = () => <ReportPage kind="weekly"/>;
export const MonthlyReportPage = () => <ReportPage kind="monthly"/>;
