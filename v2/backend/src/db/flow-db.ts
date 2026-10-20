import pg from 'pg';
import {withoutSslParams} from './connection-url.js';

const {Pool, types} = pg;

// Return DATE columns as 'YYYY-MM-DD' strings. By default pg turns them into
// a JS Date at local midnight, which can shift the business date by a day.
const PG_DATE_OID = 1082;
types.setTypeParser(PG_DATE_OID, value => value);

// Session settings for every connection:
// - default_transaction_read_only: Gaze only ever reads from Flow's database.
//   The role is already SELECT-only; this is a second guard so any write
//   fails even if the role's grants are widened later.
// - jit=off: the transaction query's estimated cost triggers JIT compilation,
//   which took ~0.5-0.7 s per run and saved less than that (measured
//   2026-10-15: 1.67 s with JIT, 1.18 s without).
const SESSION_OPTIONS = '-c default_transaction_read_only=on -c statement_timeout=15000 -c jit=off';

export function flowPoolConfig(connectionString: string): pg.PoolConfig {
    return {
        connectionString: withoutSslParams(connectionString),
        options: SESSION_OPTIONS,
        ssl: {rejectUnauthorized: false},
        connectionTimeoutMillis: 5000,
        // Warm, reused connections: opening a fresh one costs ~1.8 s on
        // Railway's proxy, which the Python app paid on every query.
        max: 10,
        idleTimeoutMillis: 30_000,
        keepAlive: true,
    };
}

let pool: pg.Pool | null = null;

export function getFlowPool(): pg.Pool {
    if (!pool) {
        const url = process.env.FLOW_DATABASE_URL;
        if (!url) throw new Error('FLOW_DATABASE_URL is not set');
        pool = new Pool(flowPoolConfig(url));
    }
    return pool;
}

export async function closeFlowPool(): Promise<void> {
    await pool?.end();
    pool = null;
}
