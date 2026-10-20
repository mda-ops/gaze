import pg from 'pg';
import {withoutSslParams} from './connection-url.js';

const {Pool} = pg;

// Gaze's own database: users, sessions, editable page blocks and settings.
// Unlike Flow's database, Gaze reads and writes here. On Railway it lives in
// the same environment as the service and is reached over the private network.

export function gazeDatabaseConfigured(): boolean {
    return Boolean(process.env.GAZE_DATABASE_URL);
}

export function gazePoolConfig(connectionString: string): pg.PoolConfig {
    // Railway's private network (*.railway.internal) and local development
    // run without TLS; anything else (e.g. a public proxy URL) uses it.
    const privateHost = /@(localhost|127\.0\.0\.1|[^/:@]+\.railway\.internal)[:/]/.test(connectionString);
    return {
        connectionString: withoutSslParams(connectionString),
        ssl: privateHost ? undefined : {rejectUnauthorized: false},
        connectionTimeoutMillis: 5000,
        max: 5,
        idleTimeoutMillis: 30_000,
    };
}

let pool: pg.Pool | null = null;

export function getGazePool(): pg.Pool {
    if (!pool) {
        const url = process.env.GAZE_DATABASE_URL;
        if (!url) throw new Error('GAZE_DATABASE_URL is not set');
        pool = new Pool(gazePoolConfig(url));
    }
    return pool;
}

export async function closeGazePool(): Promise<void> {
    await pool?.end();
    pool = null;
}
