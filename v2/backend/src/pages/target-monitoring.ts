import type pg from 'pg';
import {eachDay, type IsoDate} from '../lib/period.js';
import {loadEurUsdRate} from '../queries/fx-rate.js';

// Target Monitoring (/c-hub/target-monitoring). Reproduces the Python app's
// target_monitoring.build_target_monitoring: each model account's daily tips +
// messages against its current Flow target, with a suggested action.

export interface TargetMonitoringInput {
    start: IsoDate;
    end: IsoDate;
    eurUsdRate?: number;
}

export type TargetAction = 'Increase' | 'Keep' | 'Decrease' | 'Needs Target';

export interface TargetRow {
    model: string;
    account: string;
    platform: string;
    // 0 when the account has no Flow target ("Needs Target").
    currentTarget: number;
    hitDays: number;
    hitRate: number;
    medianHitDays: number;
    averageHitDays: number;
    medianAllDays: number;
    averageAllDays: number;
    action: TargetAction;
    suggestedTargetMedian: number;
    suggestedTarget: number;
    evaluatedDays: number;
}

export interface TargetMonitoring {
    period: {start: IsoDate; end: IsoDate};
    targetsFound: boolean;
    rows: TargetRow[];
    summary: {models: number; increase: number; keep: number; decrease: number; needsTarget: number; medianHitRate: number};
}

// Python statistics.median / pandas median.
function median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Python statistics.mean sums exactly; compensated (Neumaier) summation keeps
// the sum correctly rounded in practice.
function mean(values: number[]): number {
    if (!values.length) return 0;
    let sum = 0;
    let compensation = 0;
    for (const v of values) {
        const t = sum + v;
        compensation += Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum;
        sum = t;
    }
    return (sum + compensation) / values.length;
}

const norm = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

const ACTION_PRIORITY: Record<TargetAction, number> = {'Increase': 0, 'Decrease': 1, 'Keep': 2, 'Needs Target': 3};

export async function targetMonitoring(pool: pg.Pool, input: TargetMonitoringInput): Promise<TargetMonitoring> {
    const {start, end} = input;
    const rate = input.eurUsdRate ?? await loadEurUsdRate(pool);
    const [revenueResult, targetResult] = await Promise.all([
        // Positive tips + messages per account, model, platform and day. The
        // account is the Flow account username, else the model name. Summed in
        // exact decimals and converted once, like pandas' compensated sums:
        // medians of two days land on half cents, where float summation order
        // would flip the rounding.
        pool.query<{account: string; model: string; platform: string; date: string; revenue: number}>(`
            WITH rows AS (
                SELECT timezone('Europe/Sarajevo', t.occurred_at)::date::text AS date,
                       btrim(COALESCE(c.name, ca.username, '')) AS model,
                       CASE WHEN btrim(COALESCE(ca.username, '')) = '' OR lower(btrim(ca.username)) = 'none'
                            THEN btrim(COALESCE(c.name, ca.username, '')) ELSE btrim(ca.username) END AS account,
                       btrim(upper(COALESCE(t.platform, 'Unknown'))) AS platform,
                       COALESCE(NULLIF(upper(trim(t.currency)), ''), CASE WHEN lower(t.platform) IN ('of', 'knky') THEN 'USD' ELSE 'EUR' END) AS currency,
                       t.gross_amount
                FROM transactions t
                LEFT JOIN creators c ON c.id = t.creator_id
                LEFT JOIN creator_accounts ca ON ca.id = t.creator_account_id
                WHERE t.occurred_at >= ($1::date)::timestamp AT TIME ZONE 'Europe/Sarajevo'
                  AND t.occurred_at < ($2::date + 1)::timestamp AT TIME ZONE 'Europe/Sarajevo'
                  AND COALESCE(t.gross_amount, 0) > 0
                  AND lower(COALESCE(t.status, '')) <> 'done'
                  AND lower(COALESCE(t.type, '')) IN ('tip', 'tips', 'message', 'messages')
            )
            SELECT account, model, platform, date,
                   (COALESCE(sum(gross_amount) FILTER (WHERE currency <> 'USD'), 0)
                    + COALESCE(sum(gross_amount) FILTER (WHERE currency = 'USD'), 0) / $3::numeric)::float AS revenue
            FROM rows WHERE account <> ''
            GROUP BY 1, 2, 3, 4`, [start, end, rate]),
        // Current target per account (same source as the commissions bonus).
        pool.query<{name: string | null; platform: string; target: number}>(`
            WITH ranked AS (
                SELECT t.*, row_number() OVER (
                    PARTITION BY COALESCE(t.creator_id::text, ''), COALESCE(t.platform::text, '')
                    ORDER BY t.effective_from DESC NULLS LAST
                ) AS rn
                FROM account_targets t
            )
            SELECT c.name AS name, upper(COALESCE(t.platform, '')) AS platform, t.target_revenue::float AS target
            FROM ranked t LEFT JOIN creators c ON c.id = t.creator_id
            WHERE rn = 1 AND COALESCE(t.target_revenue, 0) > 0`),
    ]);

    // Python: _target_lookup, first target per (name, platform) wins.
    const targets = new Map<string, number>();
    for (const t of targetResult.rows) {
        const name = norm(t.name);
        const key = `${name}|${norm(t.platform)}`;
        if (name && Number(t.target) > 0 && !targets.has(key)) targets.set(key, Number(t.target));
    }

    const days = eachDay(start, end);
    const accounts = new Map<string, {account: string; model: string; platform: string; daily: Map<string, number>}>();
    for (const r of revenueResult.rows) {
        const key = [r.account, r.model, r.platform].join('\u0000');
        const entry = accounts.get(key) ?? {account: r.account, model: r.model, platform: r.platform, daily: new Map(days.map(d => [d, 0]))};
        if (entry.daily.has(r.date)) entry.daily.set(r.date, entry.daily.get(r.date)! + Number(r.revenue));
        accounts.set(key, entry);
    }

    const rows: TargetRow[] = [...accounts.values()].map(a => {
        const values = [...a.daily.values()];
        const medianAll = median(values);
        const averageAll = mean(values);
        let target = targets.get(`${norm(a.account)}|${norm(a.platform)}`) || targets.get(`${norm(a.model)}|${norm(a.platform)}`) || 0;
        if (!target) target = targets.get(`${norm(a.account)}|`) ?? targets.get(`${norm(a.model)}|`) ?? 0;
        // Without a target, days are compared with the account's own average.
        const comparison = target > 0 ? target : averageAll;
        const hits = values.filter(v => comparison > 0 && v >= comparison);
        const action: TargetAction = target <= 0 ? 'Needs Target' : hits.length >= 5 ? 'Increase' : hits.length === 0 ? 'Decrease' : 'Keep';
        let suggestedMedian = target;
        let suggested = target;
        if (action === 'Increase') {
            suggestedMedian = median(hits);
            suggested = mean(hits);
        } else if (action === 'Decrease' || action === 'Needs Target') {
            suggestedMedian = medianAll;
            suggested = averageAll;
        }
        return {
            model: a.model || a.account,
            account: a.account,
            platform: a.platform,
            currentTarget: target,
            hitDays: hits.length,
            hitRate: values.length ? hits.length / values.length * 100 : 0,
            medianHitDays: median(hits),
            averageHitDays: mean(hits),
            medianAllDays: medianAll,
            averageAllDays: averageAll,
            action,
            suggestedTargetMedian: suggestedMedian,
            suggestedTarget: suggested,
            evaluatedDays: values.length,
        };
    });
    const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    rows.sort((a, b) => ACTION_PRIORITY[a.action] - ACTION_PRIORITY[b.action]
        || b.suggestedTarget - a.suggestedTarget || textOrder(a.model, b.model) || textOrder(a.platform, b.platform));

    const count = (action: TargetAction) => rows.filter(r => r.action === action).length;
    return {
        period: {start, end},
        targetsFound: targetResult.rows.length > 0,
        rows,
        summary: {
            models: rows.length,
            increase: count('Increase'),
            keep: count('Keep'),
            decrease: count('Decrease'),
            needsTarget: count('Needs Target'),
            medianHitRate: median(rows.map(r => r.hitRate)),
        },
    };
}
