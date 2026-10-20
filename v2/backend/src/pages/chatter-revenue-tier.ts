import type pg from 'pg';
import {loadEurUsdRate} from '../queries/fx-rate.js';
import type {IsoDate} from '../lib/period.js';

// Chatting Revenue Tier (/c-hub/chatter-revenue-tier). Reproduces the Python
// app's chatter_revenue_tier.build_chatter_revenue_tier_matrix: every model's
// tier per completed month from monthly tips + messages, over all history.
// The page's date selector does not change it.

export const MONTHLY_THRESHOLDS = {A: 50_000, B: 15_000};

export type Tier = 'A' | 'B' | 'C' | '';

export interface TierCell {
    month: string;
    tier: Tier;
    // Compared with the model's previous month that had a tier.
    arrow: 'up' | 'down' | 'same' | '';
    revenue: number;
}

export interface ChatterRevenueTier {
    // First day of each month, oldest first, up to the last completed month.
    months: string[];
    rows: {model: string; cells: TierCell[]; latestTier: string; latestRevenue: number}[];
    latestCounts: {A: number; B: number; C: number};
    thresholds: typeof MONTHLY_THRESHOLDS;
}

function tierFor(amount: number): Tier {
    if (amount >= MONTHLY_THRESHOLDS.A) return 'A';
    if (amount >= MONTHLY_THRESHOLDS.B) return 'B';
    return 'C';
}

function addMonths(month: string, count: number): string {
    const d = new Date(`${month}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + count);
    return d.toISOString().slice(0, 10);
}

const RANK: Record<Tier, number> = {A: 3, B: 2, C: 1, '': 0};

export async function chatterRevenueTier(pool: pg.Pool, input: {today: IsoDate; eurUsdRate?: number}): Promise<ChatterRevenueTier> {
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    // Positive tips + messages per model and month, summed exactly and
    // converted once (see target-monitoring.ts).
    const result = await pool.query<{model: string; month: string; revenue: number}>(`
        WITH rows AS (
            SELECT btrim(COALESCE(c.name, ca.username, '')) AS model,
                   date_trunc('month', timezone('Europe/Sarajevo', t.occurred_at))::date::text AS month,
                   COALESCE(NULLIF(upper(trim(t.currency)), ''), CASE WHEN lower(t.platform) IN ('of', 'knky') THEN 'USD' ELSE 'EUR' END) AS currency,
                   t.gross_amount
            FROM transactions t
            LEFT JOIN creators c ON c.id = t.creator_id
            LEFT JOIN creator_accounts ca ON ca.id = t.creator_account_id
            WHERE t.occurred_at IS NOT NULL
              AND COALESCE(t.gross_amount, 0) > 0
              AND lower(COALESCE(t.status, '')) <> 'done'
              AND lower(btrim(COALESCE(t.type, ''))) IN ('tip', 'tips', 'message', 'messages')
        )
        SELECT model, month,
               (COALESCE(sum(gross_amount) FILTER (WHERE currency <> 'USD'), 0)
                + COALESCE(sum(gross_amount) FILTER (WHERE currency = 'USD'), 0) / $1::numeric)::float AS revenue
        FROM rows
        WHERE model NOT IN ('', 'Unknown', 'None', 'nan')
        GROUP BY 1, 2`, [rate]);

    const empty: ChatterRevenueTier = {months: [], rows: [], latestCounts: {A: 0, B: 0, C: 0}, thresholds: MONTHLY_THRESHOLDS};
    if (!result.rows.length) return empty;
    // The current, in-progress month is left out.
    const completedMonth = addMonths(`${input.today.slice(0, 8)}01`, -1);
    const dataMonths = result.rows.map(r => r.month).sort();
    const firstMonth = dataMonths[0];
    const lastMonth = dataMonths[dataMonths.length - 1] < completedMonth ? dataMonths[dataMonths.length - 1] : completedMonth;
    if (lastMonth < firstMonth) return empty;
    const months: string[] = [];
    for (let m = firstMonth; m <= lastMonth; m = addMonths(m, 1)) months.push(m);

    const revenue = new Map<string, Map<string, number>>();
    for (const r of result.rows) {
        if (r.month > lastMonth) continue;
        const own = revenue.get(r.model) ?? new Map<string, number>();
        own.set(r.month, (own.get(r.month) ?? 0) + Number(r.revenue));
        revenue.set(r.model, own);
    }

    const latestCounts = {A: 0, B: 0, C: 0};
    const rows = [...revenue.keys()]
        .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
        .map(model => {
            let previousTier: Tier = '';
            const cells: TierCell[] = months.map(month => {
                const amount = revenue.get(model)!.get(month) ?? 0;
                const tier: Tier = amount > 0 ? tierFor(amount) : '';
                const arrow: TierCell['arrow'] = !previousTier || !tier ? ''
                    : RANK[tier] > RANK[previousTier] ? 'up' : RANK[tier] < RANK[previousTier] ? 'down' : 'same';
                previousTier = tier || previousTier;
                return {month, tier, arrow, revenue: amount};
            });
            const latest = cells[cells.length - 1];
            if (latest.tier) latestCounts[latest.tier] += 1;
            return {model, cells, latestTier: latest.tier || 'No tier', latestRevenue: latest.revenue};
        });
    const tierOrder: Record<string, number> = {A: 0, B: 1, C: 2};
    rows.sort((a, b) => ((tierOrder[a.latestTier] ?? 3) - (tierOrder[b.latestTier] ?? 3))
        || (b.latestRevenue - a.latestRevenue)
        || (a.model.toLowerCase() < b.model.toLowerCase() ? -1 : a.model.toLowerCase() > b.model.toLowerCase() ? 1 : 0));
    return {months, rows, latestCounts, thresholds: MONTHLY_THRESHOLDS};
}
