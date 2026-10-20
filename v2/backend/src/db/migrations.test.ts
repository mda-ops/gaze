import path from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import {afterAll, describe, expect, it} from 'vitest';
import {gazePoolConfig} from './gaze-db.js';
import {MIGRATIONS, runMigrations} from './migrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(here, '..', '..', '..', '.env'), quiet: true});

describe('gazePoolConfig', () => {
    it('skips TLS on Railway private networking and localhost', () => {
        expect(gazePoolConfig('postgresql://u:p@postgres.railway.internal:5432/railway').ssl).toBeUndefined();
        expect(gazePoolConfig('postgresql://u:p@localhost:5432/gaze_dev').ssl).toBeUndefined();
        expect(gazePoolConfig('postgresql://u:p@yamanote.proxy.rlwy.net:28350/railway').ssl).toBeTruthy();
    });
});

// Runs against a throwaway schema in the local Gaze database, so it never
// touches real data. Skipped when GAZE_DATABASE_URL is not configured.
describe.skipIf(!process.env.GAZE_DATABASE_URL)('runMigrations', () => {
    const schema = `test_migrations_${process.pid}`;
    const pool = new pg.Pool({...gazePoolConfig(process.env.GAZE_DATABASE_URL ?? ''), options: `-c search_path=${schema}`, max: 2});

    afterAll(async () => {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.end();
    });

    it('applies every migration once and is idempotent', async () => {
        await pool.query(`CREATE SCHEMA ${schema}`);
        expect(await runMigrations(pool)).toEqual(MIGRATIONS.map(m => m.version));
        expect(await runMigrations(pool)).toEqual([]);
        const tables = (await pool.query<{table_name: string}>(
            'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name', [schema],
        )).rows.map(r => r.table_name);
        expect(tables).toEqual(['app_settings', 'schema_migrations', 'sessions', 'site_blocks', 'user_photos', 'users']);
    });
});
