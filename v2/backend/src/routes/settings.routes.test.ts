import path from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import type {FastifyInstance} from 'fastify';
import pg from 'pg';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {buildApp} from '../app.js';
import {gazePoolConfig} from '../db/gaze-db.js';
import {runMigrations} from '../db/migrations.js';
import {hashPassword} from '../lib/passwords.js';
import {loadSettings} from '../lib/settings.js';
import {SESSION_COOKIE} from '../plugins/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(here, '..', '..', '..', '.env'), quiet: true});

describe.skipIf(!process.env.GAZE_DATABASE_URL)('settings and data sources routes', () => {
    const schema = `test_settings_${process.pid}`;
    const pool = new pg.Pool({...gazePoolConfig(process.env.GAZE_DATABASE_URL ?? ''), options: `-c search_path=${schema}`, max: 3});
    let app: FastifyInstance;
    let admin: Record<string, string>;
    let viewer: Record<string, string>;

    const valid = {
        reporting_week_start: 'Monday', default_currency: 'USD', timezone: 'Europe/Sarajevo', unlock_threshold: 150,
        anomaly_revenue_drop_pct: 25, anomaly_revenue_spike_pct: 45, revenue_catcher_base_url: 'https://flow.example.com/',
    };

    beforeAll(async () => {
        await pool.query(`CREATE SCHEMA ${schema}`);
        await runMigrations(pool);
        await pool.query(
            `INSERT INTO users (key, name, title, role, username, password_hash, allowed_routes) VALUES
             ('anne', 'Anne', 'Admin', 'admin', 'anne', $1, '{*}'),
             ('zed', 'Zed', 'CEO', 'viewer', 'zed', $1, '{*}')`,
            [hashPassword('pw')],
        );
        app = await buildApp({gazePool: pool});
        const headersFor = async (username: string) => {
            const login = await app.inject({method: 'POST', url: '/api/auth/login', payload: {username, password: 'pw'}});
            return {cookie: `${SESSION_COOKIE}=${login.cookies.find(c => c.name === SESSION_COOKIE)?.value}`};
        };
        admin = await headersFor('anne');
        viewer = await headersFor('zed');
    });

    afterAll(async () => {
        await app?.close();
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.end();
    });

    it('shows the live settings with their defaults', async () => {
        const res = await app.inject({url: '/api/settings', headers: admin});
        expect(res.json().values).toEqual({
            reporting_week_start: 'Friday', default_currency: 'EUR', timezone: 'Europe/Amsterdam', unlock_threshold: 199,
            anomaly_revenue_drop_pct: 30, anomaly_revenue_spike_pct: 40, revenue_catcher_base_url: 'https://revenuecatcher-production.up.railway.app',
        });
    });

    it('saves valid settings', async () => {
        const res = await app.inject({method: 'POST', url: '/api/settings', headers: admin, payload: valid});
        expect(res.statusCode).toBe(200);
        const settings = await loadSettings(pool);
        expect(settings.timezone).toBe('Europe/Sarajevo');
        expect(settings.unlock_threshold).toBe(150);
        expect(settings.default_currency).toBe('USD');
    });

    it('refuses invalid values and saves nothing', async () => {
        for (const bad of [{timezone: 'Mars/Base'}, {reporting_week_start: 'Funday'}, {unlock_threshold: 'abc'}, {revenue_catcher_base_url: 'javascript:alert(1)'}]) {
            const res = await app.inject({method: 'POST', url: '/api/settings', headers: admin, payload: {...valid, timezone: 'Europe/Paris', ...bad}});
            expect(res.statusCode).toBe(400);
        }
        expect((await loadSettings(pool)).timezone).toBe('Europe/Sarajevo');
    });

    it('builds the Flow links from the saved address', async () => {
        const links = (await app.inject({url: '/api/data-sources', headers: admin})).json().links;
        expect(links.map((l: {label: string}) => l.label)).toEqual(['Master Sheet', 'Looker Studio', 'Flow', 'Inactivity page']);
        expect(links[2].url).toBe('https://flow.example.com/manager');
        expect(links[3].url).toMatch(/^https:\/\/flow\.example\.com\/manager\/inactivity\?from=2026-05-20&to=\d{4}-\d{2}-\d{2}$/);
    });

    it('is hidden from viewers, even with access to every page', async () => {
        for (const url of ['/api/settings', '/api/data-sources']) {
            expect((await app.inject({url, headers: viewer})).statusCode).toBe(404);
        }
        expect((await app.inject({method: 'POST', url: '/api/settings', headers: viewer, payload: valid})).statusCode).toBe(404);
    });
});
