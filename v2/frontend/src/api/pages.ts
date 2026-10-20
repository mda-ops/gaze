import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {apiQueryString, type FilterField, type PageQuery} from '../lib/pageQuery';
import type {TrendDay} from '../components/TrendChart';
import {api} from './client';

// Response of GET /api/pages/executive-overview (backend/src/pages/executive-overview.ts).
export interface ExecutiveOverviewData {
    period: {start: string; end: string; compare: string; compareStart: string; compareEnd: string};
    eurUsdRate: number;
    metrics: {
        totalRevenue: number;
        previousRevenue: number;
        revenueChangePct: number | null;
        flowManagerGross: number | null;
        flowManagerNet: number | null;
        revenuePerHour: number | null;
        activeChatters: number;
        activeCreators: number;
        totalHours: number;
        totalInactivityMinutes: number | null;
        medianPerChatter: number | null;
        avgPerCreator: number | null;
    };
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    revenueByType: {transactionType: string | null; revenue: number; days: number; rows: number}[];
    trend: {start: string; today: string; current: TrendDay[]; previous: TrendDay[]; previousLabel: string};
    filterOptions: Record<FilterField, string[]>;
}

export function useExecutiveOverview(query: PageQuery | null) {
    const search = query ? apiQueryString(query) : '';
    return useQuery({
        queryKey: ['executive-overview', search],
        queryFn: () => api<ExecutiveOverviewData>(`/api/pages/executive-overview?${search}`),
        enabled: query !== null,
        // Keep showing the previous numbers while new filters load.
        placeholderData: keepPreviousData,
    });
}

// Response of GET /api/pages/model-revenue (backend/src/pages/model-revenue.ts).
export interface ModelRevenueData {
    period: {start: string; end: string; compare: string; compareStart: string; compareEnd: string};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    platformTotals: {platform: string; revenue: number; share: number}[];
    cards: {
        model: string;
        total: number;
        subscriptionRevenue: number;
        currentSubs: number;
        agencies: string[];
        tiers: string[];
        platforms: {platform: string; revenue: number; share: number; currentSubs: number}[];
    }[];
    filterOptions: {creator: string[]; platform: string[]; agency: string[]; team: string[]; transaction_type: string[]};
    trend: {start: string; today: string; current: TrendDay[]; previous: TrendDay[]; previousLabel: string};
}

// `extra` holds the page's own query parameters (model card filters).
export function useModelRevenue(query: PageQuery | null, extra: URLSearchParams) {
    const search = query ? `${apiQueryString(query)}&${extra.toString()}` : '';
    return useQuery({
        queryKey: ['model-revenue', search],
        queryFn: () => api<ModelRevenueData>(`/api/pages/model-revenue?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

// Response of GET /api/pages/chatter-revenue (backend/src/pages/chatter-revenue.ts).
export interface ChatterRevenueData {
    period: {start: string; end: string; compare: string; compareStart: string; compareEnd: string};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    metrics: {
        totalRevenue: number;
        revenueChangePct: number | null;
        activeChatters: number;
        avgPerChatter: number | null;
        revenuePerHour: number | null;
        totalHours: number;
    };
    platformTotals: {platform: string; revenue: number; share: number}[];
    cards: {chatter: string; total: number; revenuePerHour: number | null; platforms: {platform: string; revenue: number; share: number}[]}[];
    filterOptions: {chatter: string[]; platform: string[]; team: string[]; creator: string[]; transaction_type: string[]};
}

export function useChatterRevenue(query: PageQuery | null, extra: URLSearchParams) {
    const search = query ? `${apiQueryString(query)}&${extra.toString()}` : '';
    return useQuery({
        queryKey: ['chatter-revenue', search],
        queryFn: () => api<ChatterRevenueData>(`/api/pages/chatter-revenue?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

// Response of GET /api/pages/transactions (backend/src/pages/transactions.ts).
export interface TransactionsData {
    period: {start: string; end: string; compare: string; compareStart: string; compareEnd: string};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    threshold: number;
    types: string[];
    rows: {
        creator: string | null;
        date: string;
        timestamp: string;
        amount: number;
        transactionType: string | null;
        chatter: string | null;
        chatterStatus: string;
        platform: string | null;
    }[];
    filterOptions: Record<FilterField, string[]>;
}

export function useTransactions(apiPath: string, query: PageQuery | null, extra: URLSearchParams) {
    const search = query ? `${apiQueryString(query)}&${extra.toString()}` : '';
    return useQuery({
        queryKey: ['transactions', apiPath, search],
        queryFn: () => api<TransactionsData>(`${apiPath}?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

interface InactivitySummary {
    events: number;
    peakUnread: number;
    totalHours: number;
    moneyWasted: number;
    worstChatter: string | null;
    worstMoney: number;
}

// Response of GET /api/pages/inactivity (backend/src/pages/inactivity.ts).
export interface InactivityData {
    period: {start: string; end: string; compare: string; compareStart: string; compareEnd: string};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    current: InactivitySummary;
    previous: InactivitySummary;
    tiers: {creatorTier: string; events: number; models: number; scheduledHours: number; moneyWasted: number; shiftHours: number; inactivityPct: number; avgCostPerHour: number}[];
    chatters: {chatter: string; events: number; creators: number; platforms: string; peakUnread: number; totalHours: number; maxHours: number; moneyWasted: number; avgCostPerHour: number}[];
    insights: {
        topMoney: InactivityData['chatters'][number];
        topUnread: InactivityData['chatters'][number];
        topHours: InactivityData['chatters'][number];
    } | null;
    filterOptions: Record<FilterField, string[]>;
    managerUrl: string;
}

export function useInactivity(apiPath: string, query: PageQuery | null) {
    const search = query ? apiQueryString(query) : '';
    return useQuery({
        queryKey: ['inactivity', apiPath, search],
        queryFn: () => api<InactivityData>(`${apiPath}?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

type Amount = number | null;

// Response of GET /api/pages/commissions (backend/src/pages/commissions.ts).
export interface CommissionsData {
    period: {start: string; end: string; compare: string; compareStart: string; compareEnd: string};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    ledger: {
        source: string; gross_revenue: Amount; external_revenue_splits: Amount; agency_revenue: Amount; direct_revenue_costs: Amount;
        net_revenue: Amount; profit_loss: Amount; profit_margin_pct: Amount; is_complete: boolean;
    };
    cards: {
        baseCommission: number; flowBonus: number; preSalaryCommission: number; salaryCost: number; postSalaryCommission: number;
        chatManagerCuts: number; adminManagementPool: number; operatingExpenses: number; operatingExpensesEur: number;
        operatingExpensesUsd: number; mdEarningsAfterExpenses: number;
    };
    breakdown: {lineItem: string; amount: Amount; sharePct: Amount; source: string}[];
    pnl: {line: string; amount: Amount}[];
    teams: {team: string; baseCommission: number; flowBonus: number; preSalaryCommission: number; salaryCost: number; postSalaryCommission: number}[];
    audit: {status: string; transactions: number; revenue: number; meaning: string}[];
    managers: {team: string; chatManager: string; managerCut: number; attributedRevenue: number; managerCutPct: number}[];
    departments: {department: string; monthlyEur: number; monthlyUsd: number; periodEur: number; periodUsd: number; periodEurReporting: number}[];
    costTeams: {team: string; grossRevenue: Amount; nonChatterCosts: Amount; preSalary: number; salaryCost: number; totalCost: Amount; postSalary: number}[];
    chatters: {team: string; chatter: string; baseCommission: number; commissionPlan: string; salaryCost: number; flowBonus: number; preSalaryCommission: number; postSalaryCommission: number}[];
    creators: {creator: string | null; grossRev: number; netRev: number}[];
    filterOptions: Record<FilterField, string[]>;
}

export function useCommissions(apiPath: string, query: PageQuery | null) {
    const search = query ? apiQueryString(query) : '';
    return useQuery({
        queryKey: ['commissions', apiPath, search],
        queryFn: () => api<CommissionsData>(`${apiPath}?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

// Response of GET /api/pages/target-monitoring (backend/src/pages/target-monitoring.ts).
export interface TargetMonitoringData {
    period: {start: string; end: string};
    comparePeriod: {compare: string; compareStart: string; compareEnd: string};
    targetsFound: boolean;
    rows: {
        model: string; account: string; platform: string; currentTarget: number; hitDays: number; hitRate: number;
        medianHitDays: number; averageHitDays: number; medianAllDays: number; averageAllDays: number;
        action: string; suggestedTargetMedian: number; suggestedTarget: number; evaluatedDays: number;
    }[];
    summary: {models: number; increase: number; keep: number; decrease: number; needsTarget: number; medianHitRate: number};
}

export function useTargetMonitoring(query: PageQuery | null) {
    const search = query ? new URLSearchParams({start: query.start, end: query.end, compare: query.compare}).toString() : '';
    return useQuery({
        queryKey: ['target-monitoring', search],
        queryFn: () => api<TargetMonitoringData>(`/api/pages/target-monitoring?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

// Response of GET /api/pages/chatter-revenue-tier (backend/src/pages/chatter-revenue-tier.ts).
export interface ChatterRevenueTierData {
    months: string[];
    rows: {model: string; cells: {month: string; tier: string; arrow: string; revenue: number}[]; latestTier: string; latestRevenue: number}[];
    latestCounts: {A: number; B: number; C: number};
    thresholds: {A: number; B: number};
    comparePeriod: {compare: string; compareStart: string; compareEnd: string};
}

export function useChatterRevenueTier(query: PageQuery | null) {
    const search = query ? new URLSearchParams({start: query.start, end: query.end, compare: query.compare}).toString() : '';
    return useQuery({
        queryKey: ['chatter-revenue-tier', search],
        queryFn: () => api<ChatterRevenueTierData>(`/api/pages/chatter-revenue-tier?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

interface HubWeek {
    week: string; start: string; end: string; teamStrength: number; modelRequirement: number; gap: number;
    scheduledChatters: number; hours: number; revenue: number; revenuePerHour: number; hrMatchedChatters: number;
}

interface HubShared {
    tierMix: {tier: string; chatters: number; strength: number}[];
    creators: {creator: string; creatorId: string | null; revenue: number; modelTier: string; requirement: number; requiredWeeklyHours: number; modelTierSource: string}[];
    transition: {chatter: string; status: string; team: string; tier: string; skillGrade: number}[];
    comparePeriod: {compare: string; compareStart: string; compareEnd: string};
}

// Response of GET /api/pages/performance (backend/src/pages/performance-hub.ts).
export interface PerformanceHubData extends HubShared {
    weeks: HubWeek[];
    current: {
        chatter: string; tier: string; skillGrade: number; chatQuality: number; activityBehaviour: number; scheduledHours: number;
        operatingPotential: number; revenue: number; revPerHour: number; notionTier: string; team: string; hrProfileFound: boolean;
        scorePending: boolean; latestGradeDate: string | null;
    }[];
    hrSource: string;
    hrRows: number;
}

// Response of GET /api/pages/performance-2.
export interface PerformanceHub2Data extends HubShared {
    weeks: (HubWeek & {scheduledStrength: number; capacityHours: number; capacityMissingChatters: number; utilizationPct: number})[];
    current: {
        chatter: string; tier: string; skillGrade: number; chatQuality: number; activityBehaviour: number; weeklyCapacityHours: number;
        scheduledHours: number; capacityGapHours: number; utilizationPct: number; qualityAdjustedCapacity: number; qualityAdjustedScheduled: number;
        revenue: number; revPerHour: number; notionTier: string; team: string; hrProfileFound: boolean; scorePending: boolean;
        capacityMissing: boolean; capacitySource: string; latestGradeDate: string | null;
    }[];
    filterOptions: {teams: string[]; tiers: string[]};
}

function periodSearch(query: PageQuery): string {
    return new URLSearchParams({start: query.start, end: query.end, compare: query.compare}).toString();
}

export function usePerformanceHub(query: PageQuery | null) {
    const search = query ? periodSearch(query) : '';
    return useQuery({
        queryKey: ['performance', search],
        queryFn: () => api<PerformanceHubData>(`/api/pages/performance?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

export function usePerformanceHub2(query: PageQuery | null, extra: URLSearchParams) {
    const search = query ? `${periodSearch(query)}&${extra.toString()}` : '';
    return useQuery({
        queryKey: ['performance-2', search],
        queryFn: () => api<PerformanceHub2Data>(`/api/pages/performance-2?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

// One row of the Python app's group_performance (column names kept).
export interface GroupRow {
    key: string; revenue: number; hours: number; messages: number; inactivity: number; transactions: number; creators_worked: number;
    days: number; previous_revenue: number; change_amount: number; change_pct: number | null; revenue_per_hour: number | null;
    messages_per_hour: number | null; revenue_share_pct: number | null; average_revenue_per_day: number | null; average_transaction_value: number | null;
}

// Response of GET /api/pages/{revenue,chatters,creators,platforms} (backend/src/pages/core-analysis.ts).
export interface CoreAnalysisData {
    period: {start: string; end: string; compare: string; compareStart: string; compareEnd: string};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    coverage: {creator: boolean; chatter: boolean; platform: boolean};
    revenueByType: {transaction_type: string | null; revenue: number; days: number; rows: number}[];
    groups: Partial<Record<'creator' | 'chatter' | 'platform', GroupRow[]>>;
    creatorExtras: (GroupRow & {
        active_chatters: number | null; unlock_revenue: number | null; tip_revenue: number | null;
        subscription_revenue: number | null; revenue_per_chatter: number | null;
    })[] | null;
    filterOptions: Record<FilterField, string[]>;
}

export function useCoreAnalysis(page: string, query: PageQuery | null) {
    const search = query ? apiQueryString(query) : '';
    return useQuery({
        queryKey: ['core', page, search],
        queryFn: () => api<CoreAnalysisData>(`/api/pages${page}?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

interface AnalysisFrame {
    period: {start: string; end: string; compare: string; compareStart: string; compareEnd: string};
    eurUsdRate: number;
    comparison: {currentRevenue: number | null; previousRevenue: number | null};
    filterOptions: Record<FilterField, string[]>;
}

// Response of GET /api/pages/insights (backend/src/pages/insights.ts).
export interface InsightsData extends AnalysisFrame {
    facts: string[];
    flags: {area: string; name: string; severity: string; message: string; why: string}[];
}

// Response of GET /api/pages/ask (backend/src/pages/ask.ts).
export interface AskData extends AnalysisFrame {
    question: string;
    answer:
        | {kind: 'none'}
        | {kind: 'improved'; chatter: string; changeAmount: number}
        | {kind: 'highHours'; chatter: string; hours: number; revenuePerHour: number | null}
        | {kind: 'bestRate'; chatter: string; revenuePerHour: number | null};
}

export function useInsights(query: PageQuery | null) {
    const search = query ? apiQueryString(query) : '';
    return useQuery({
        queryKey: ['insights', search],
        queryFn: () => api<InsightsData>(`/api/pages/insights?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

export function useAsk(query: PageQuery | null, question: string | null) {
    const search = query ? `${apiQueryString(query)}${question === null ? '' : `&${new URLSearchParams({question})}`}` : '';
    return useQuery({
        queryKey: ['ask', search],
        queryFn: () => api<AskData>(`/api/pages/ask?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}

interface TierAssignment {
    cadence: string; tier: string; model: string; tier_revenue: number; selected_revenue: number; active_days: number; transactions: number;
}

// Response of GET /api/pages/revenue-tiers (backend/src/pages/revenue-tiers.ts).
export interface RevenueTiersData extends AnalysisFrame {
    days: number;
    byModel: {
        model: string; selected_revenue: number; active_days: number; transactions: number; daily_revenue: number; weekly_revenue: number;
        monthly_revenue: number; daily_tier: string; weekly_tier: string; monthly_tier: string;
    }[];
    thresholds: {cadence: string; tier: string; range: string}[];
    tierSummary: {cadence: string; tier: string; range: string; models: number; revenue: number; avg_model_revenue: number}[];
    weeklyMix: {tier: string; models: number; revenue: number}[];
    topModels: {model: string; weekly_revenue: number; weekly_tier: string}[];
    assignments: Record<'daily' | 'weekly' | 'monthly', TierAssignment[]>;
}

export function useRevenueTiers(query: PageQuery | null) {
    const search = query ? apiQueryString(query) : '';
    return useQuery({
        queryKey: ['revenue-tiers', search],
        queryFn: () => api<RevenueTiersData>(`/api/pages/revenue-tiers?${search}`),
        enabled: query !== null,
        placeholderData: keepPreviousData,
    });
}
