import type pg from 'pg';

// Flow's current EUR/USD rate (USD per EUR): divide USD amounts by it to get
// EUR. Same source as the Python app (app/currency.py) and Flow's own UI.
// Fails rather than assuming parity when the rate is missing or invalid.
export async function loadEurUsdRate(pool: pg.Pool): Promise<number> {
    const result = await pool.query<{eur_usd_rate: string | number | null}>(
        'SELECT eur_usd_rate FROM fx_rate_cache ORDER BY fetched_at DESC LIMIT 1',
    );
    const rate = Number(result.rows[0]?.eur_usd_rate);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Flow EUR/USD rate is unavailable.');
    return rate;
}
