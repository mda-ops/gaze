import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {getFlowPool} from '../db/flow-db.js';
import {parseFilters} from '../lib/filters.js';
import {COMPARE_MODES, comparisonRange, isIsoDate, todayIn} from '../lib/period.js';
import {loadSettings} from '../lib/settings.js';
import {agencyLabel} from '../lib/rosters.js';
import {executiveOverview} from '../pages/executive-overview.js';
import {inactivity} from '../pages/inactivity.js';
import {cHubOverview} from '../pages/c-hub-overview.js';
import {chatterRevenue} from '../pages/chatter-revenue.js';
import {chatterRevenueTier} from '../pages/chatter-revenue-tier.js';
import {commissions} from '../pages/commissions.js';
import {ask} from '../pages/ask.js';
import {coreAnalysis, type Group} from '../pages/core-analysis.js';
import {insights} from '../pages/insights.js';
import * as looker from '../pages/looker.js';
import {modelRevenue, type ModelSort} from '../pages/model-revenue.js';
import {performanceHub, performanceHub2} from '../pages/performance-hub.js';
import {report} from '../pages/reports.js';
import {revenueTiers} from '../pages/revenue-tiers.js';
import {targetMonitoring} from '../pages/target-monitoring.js';
import {transactions} from '../pages/transactions.js';
import {requirePage} from '../plugins/auth.js';

// Data for each page, one route per page. Each route is limited to users
// who may open that page.

const PeriodQuery = z.object({
    start: z.string().refine(isIsoDate, 'start must be YYYY-MM-DD'),
    end: z.string().refine(isIsoDate, 'end must be YYYY-MM-DD'),
    compare: z.enum(COMPARE_MODES).default('Previous period'),
}).refine(q => q.start <= q.end, 'start must not be after end');

// Repeated query values (?model_creator=Anna&model_creator=Jane) as a list.
function list(query: Record<string, unknown>, name: string): string[] {
    const raw = query[name];
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    return values.map(String).filter(v => v !== '');
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    const text = String(value ?? '').trim().toLowerCase();
    return (allowed as readonly string[]).includes(text) ? text as T : fallback;
}

export default async function pagesRoutes(fastify: FastifyInstance) {
    // What the page frame needs for date presets and money formatting.
    fastify.get('/api/config', async () => {
        const settings = await loadSettings(fastify.gazePool);
        return {
            today: todayIn(settings.timezone),
            reportingWeekStart: settings.reporting_week_start,
            defaultCurrency: settings.default_currency,
        };
    });

    fastify.get('/api/pages/executive-overview', {preHandler: requirePage('/c-hub/executive-overview')}, async (request, reply) => {
        const query = request.query as Record<string, unknown>;
        const period = PeriodQuery.safeParse(query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        const settings = await loadSettings(fastify.gazePool);
        return executiveOverview(getFlowPool(), {
            ...period.data,
            filters: parseFilters(query),
            today: todayIn(settings.timezone),
        });
    });

    fastify.get('/api/pages/model-revenue', {preHandler: requirePage('/c-hub/revenue')}, async (request, reply) => {
        const query = request.query as Record<string, unknown>;
        const period = PeriodQuery.safeParse(query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        const settings = await loadSettings(fastify.gazePool);
        // Same parameter names as the Python app's model card filter form.
        return modelRevenue(getFlowPool(), {
            ...period.data,
            filters: {
                creator: list(query, 'model_creator'),
                platform: list(query, 'model_platform'),
                agency: list(query, 'model_agency').map(agencyLabel),
                team: list(query, 'model_team'),
                transaction_type: list(query, 'model_transaction_type'),
            },
            sort: oneOf<ModelSort>(query.model_sort, ['revenue', 'subscriptions', 'model'], 'revenue'),
            direction: oneOf(query.model_sort_direction, ['asc', 'desc'], 'desc'),
            today: todayIn(settings.timezone),
        });
    });

    fastify.get('/api/pages/chatter-revenue', {preHandler: requirePage('/c-hub/chatter-revenue')}, async (request, reply) => {
        const query = request.query as Record<string, unknown>;
        const period = PeriodQuery.safeParse(query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        // Same parameter names as the Python app's chatter card filter form.
        return chatterRevenue(getFlowPool(), {
            ...period.data,
            filters: {
                chatter: list(query, 'chatter_name'),
                platform: list(query, 'chatter_platform'),
                team: list(query, 'chatter_team'),
                creator: list(query, 'chatter_creator'),
                transaction_type: list(query, 'chatter_transaction_type'),
            },
            sort: oneOf(query.chatter_sort, ['revenue', 'chatter'], 'revenue'),
            direction: oneOf(query.chatter_sort_direction, ['asc', 'desc'], 'desc'),
        });
    });

    // Core analysis pages and the groupings each one shows.
    const coreGroups: Record<string, Group[]> = {
        '/revenue': ['creator', 'chatter'],
        '/chatters': ['chatter'],
        '/creators': ['creator'],
        '/platforms': ['platform'],
    };
    for (const [page, groups] of Object.entries(coreGroups)) {
        fastify.get(`/api/pages${page}`, {preHandler: requirePage(page)}, async (request, reply) => {
            const query = request.query as Record<string, unknown>;
            const period = PeriodQuery.safeParse(query);
            if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
            return coreAnalysis(getFlowPool(), {...period.data, filters: parseFilters(query), groups});
        });
    }

    fastify.get('/api/pages/insights', {preHandler: requirePage('/insights')}, async (request, reply) => {
        const query = request.query as Record<string, unknown>;
        const period = PeriodQuery.safeParse(query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        const settings = await loadSettings(fastify.gazePool);
        return insights(getFlowPool(), {
            ...period.data,
            filters: parseFilters(query),
            dropPct: Number(settings.anomaly_revenue_drop_pct ?? 30),
            spikePct: Number(settings.anomaly_revenue_spike_pct ?? 40),
        });
    });

    fastify.get('/api/pages/ask', {preHandler: requirePage('/ask')}, async (request, reply) => {
        const query = request.query as Record<string, unknown>;
        const period = PeriodQuery.safeParse(query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        // An empty question counts as missing (Python parse_qs drops blank values).
        const question = String(query.question ?? '') || 'Who improved the most?';
        return ask(getFlowPool(), {...period.data, filters: parseFilters(query), question});
    });

    fastify.get('/api/pages/revenue-tiers', {preHandler: requirePage('/revenue-tiers')}, async (request, reply) => {
        const query = request.query as Record<string, unknown>;
        const period = PeriodQuery.safeParse(query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        return revenueTiers(getFlowPool(), {...period.data, filters: parseFilters(query)});
    });

    fastify.get('/api/pages/c-hub', {preHandler: requirePage('/c-hub')}, async (request, reply) => {
        const period = PeriodQuery.safeParse(request.query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        const settings = await loadSettings(fastify.gazePool);
        return cHubOverview(getFlowPool(), {...period.data, currentYear: Number(todayIn(settings.timezone).slice(0, 4))});
    });

    for (const kind of ['weekly', 'monthly'] as const) {
        fastify.get(`/api/pages/${kind}-report`, {preHandler: requirePage(`/${kind}-report`)}, async (request, reply) => {
            const query = request.query as Record<string, unknown>;
            const period = PeriodQuery.safeParse(query);
            if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
            const settings = await loadSettings(fastify.gazePool);
            return report(getFlowPool(), {
                ...period.data, kind, filters: parseFilters(query), currentYear: Number(todayIn(settings.timezone).slice(0, 4)),
            });
        });
    }

    // Hub pages and their C Hub versions (Google Sheets, cached snapshots).
    const lookerPages: Record<string, (input: looker.LookerInput) => Promise<object>> = {
        '/compliance-dash': looker.complianceDash,
        '/marketing': looker.marketing,
        '/models-socials': looker.modelsSocials,
        '/of-new-fan-growth': looker.ofNewFanGrowth,
        '/ads-performance': looker.adsPerformance,
        '/notion-tickets': looker.notionTickets,
        '/c-hub/compliance': looker.cHubCompliance,
        '/c-hub/marketing-ads': looker.cHubMarketingAds,
        '/c-hub/models-socials': looker.cHubModelsSocials,
        '/c-hub/of-new-fans': looker.cHubOfNewFans,
        '/c-hub/ads-performance': looker.cHubAdsPerformance,
        '/c-hub/tickets': looker.cHubTickets,
    };
    for (const [page, build] of Object.entries(lookerPages)) {
        fastify.get(`/api/looker${page}`, {preHandler: requirePage(page)}, async (request, reply) => {
            const period = PeriodQuery.safeParse(request.query);
            if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
            const settings = await loadSettings(fastify.gazePool);
            const {start, end, compare} = period.data;
            const [compareStart, compareEnd] = comparisonRange(start, end, compare);
            // Dates without a year are read in the current year (Python: date.today()).
            const currentYear = Number(todayIn(settings.timezone).slice(0, 4));
            return {...await build({start, end, currentYear}), comparePeriod: {compare, compareStart, compareEnd}};
        });
    }

    // Same data on the Core page and its C Hub copy; each needs its own access.
    for (const page of ['/transactions', '/c-hub/transactions']) {
        const url = page === '/transactions' ? '/api/pages/transactions' : '/api/pages/c-hub-transactions';
        fastify.get(url, {preHandler: requirePage(page)}, async (request, reply) => {
            const query = request.query as Record<string, unknown>;
            const period = PeriodQuery.safeParse(query);
            if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
            const settings = await loadSettings(fastify.gazePool);
            const threshold = Number(query.threshold ?? settings.unlock_threshold);
            if (!Number.isFinite(threshold)) return reply.code(400).send({error: 'threshold must be a number.'});
            const types = list(query, 'tx_type');
            return transactions(getFlowPool(), {
                ...period.data,
                filters: parseFilters(query),
                // Python app defaults: tips and messages, settings unlock_threshold.
                types: types.length ? types : ['tip', 'message'],
                threshold,
            });
        });
    }

    for (const page of ['/inactivity', '/c-hub/inactivity']) {
        const url = page === '/inactivity' ? '/api/pages/inactivity' : '/api/pages/c-hub-inactivity';
        fastify.get(url, {preHandler: requirePage(page)}, async (request, reply) => {
            const query = request.query as Record<string, unknown>;
            const period = PeriodQuery.safeParse(query);
            if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
            const settings = await loadSettings(fastify.gazePool);
            // Transaction type does not apply to inactivity.
            const filters = {...parseFilters(query), transaction_type: []};
            const {currentEpisodes: _episodes, ...data} = await inactivity(getFlowPool(), {...period.data, filters});
            const base = String(settings.revenue_catcher_base_url ?? 'https://revenuecatcher-production.up.railway.app').replace(/\/+$/, '');
            return {...data, managerUrl: `${base}/manager/inactivity?from=${period.data.start}&to=${period.data.end}`};
        });
    }

    for (const page of ['/commissions', '/c-hub/commissions']) {
        const url = page === '/commissions' ? '/api/pages/commissions' : '/api/pages/c-hub-commissions';
        fastify.get(url, {preHandler: requirePage(page)}, async (request, reply) => {
            const query = request.query as Record<string, unknown>;
            const period = PeriodQuery.safeParse(query);
            if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
            const settings = await loadSettings(fastify.gazePool);
            return commissions(getFlowPool(), {...period.data, filters: parseFilters(query), settings});
        });
    }

    fastify.get('/api/pages/target-monitoring', {preHandler: requirePage('/c-hub/target-monitoring')}, async (request, reply) => {
        const period = PeriodQuery.safeParse(request.query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        const {start, end, compare} = period.data;
        const [compareStart, compareEnd] = comparisonRange(start, end, compare);
        return {...await targetMonitoring(getFlowPool(), {start, end}), comparePeriod: {compare, compareStart, compareEnd}};
    });

    // The tier matrix covers all completed months; the period only drives the
    // page's date bar and comparison strip.
    fastify.get('/api/pages/chatter-revenue-tier', {preHandler: requirePage('/c-hub/chatter-revenue-tier')}, async (request, reply) => {
        const period = PeriodQuery.safeParse(request.query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        const settings = await loadSettings(fastify.gazePool);
        const {start, end, compare} = period.data;
        const [compareStart, compareEnd] = comparisonRange(start, end, compare);
        return {...await chatterRevenueTier(getFlowPool(), {today: todayIn(settings.timezone)}), comparePeriod: {compare, compareStart, compareEnd}};
    });

    // Four reporting weeks ending with the selected end date.
    fastify.get('/api/pages/performance', {preHandler: requirePage('/c-hub/performance')}, async (request, reply) => {
        const period = PeriodQuery.safeParse(request.query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        const settings = await loadSettings(fastify.gazePool);
        const {start, end, compare} = period.data;
        const [compareStart, compareEnd] = comparisonRange(start, end, compare);
        const hub = await performanceHub(getFlowPool(), {end, weekStart: settings.reporting_week_start});
        return {...hub, comparePeriod: {compare, compareStart, compareEnd}};
    });

    fastify.get('/api/pages/performance-2', {preHandler: requirePage('/c-hub/performance-2')}, async (request, reply) => {
        const query = request.query as Record<string, unknown>;
        const period = PeriodQuery.safeParse(query);
        if (!period.success) return reply.code(400).send({error: period.error.issues[0]?.message ?? 'Invalid period.'});
        const settings = await loadSettings(fastify.gazePool);
        const {start, end, compare} = period.data;
        const [compareStart, compareEnd] = comparisonRange(start, end, compare);
        // Same parameter names as the Python app's Performance Hub 2 form.
        const filters = {
            team: String(query.ph2_team ?? '').trim(),
            tier: String(query.ph2_tier ?? '').trim(),
            score: String(query.ph2_score ?? '').trim(),
        };
        const hub = await performanceHub2(getFlowPool(), {end, weekStart: settings.reporting_week_start, filters});
        return {...hub, filters, comparePeriod: {compare, compareStart, compareEnd}};
    });
}
