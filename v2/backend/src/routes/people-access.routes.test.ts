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
import {SHAREABLE_ROUTES} from '../lib/auth.js';
import {SESSION_COOKIE} from '../plugins/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(here, '..', '..', '..', '.env'), quiet: true});

describe.skipIf(!process.env.GAZE_DATABASE_URL)('people access routes', () => {
    const schema = `test_people_${process.pid}`;
    const pool = new pg.Pool({...gazePoolConfig(process.env.GAZE_DATABASE_URL ?? ''), options: `-c search_path=${schema}`, max: 3});
    let app: FastifyInstance;

    beforeAll(async () => {
        await pool.query(`CREATE SCHEMA ${schema}`);
        await runMigrations(pool);
        await pool.query(
            `INSERT INTO users (key, name, title, role, username, password_hash, allowed_routes, sort_order) VALUES
             ('anne', 'Anne', 'Admin', 'admin', 'anne', $1, '{*}', 0),
             ('zed', 'Zed', 'CEO', 'viewer', 'zed', $1, '{/c-hub/revenue,/transactions}', 1),
             ('all', 'All', 'Viewer', 'viewer', 'all', $1, '{*}', 2)`,
            [hashPassword('pw')],
        );
        app = await buildApp({gazePool: pool});
    });

    afterAll(async () => {
        await app?.close();
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.end();
    });

    async function headersFor(username: string) {
        const login = await app.inject({method: 'POST', url: '/api/auth/login', payload: {username, password: 'pw'}});
        return {cookie: `${SESSION_COOKIE}=${login.cookies.find(c => c.name === SESSION_COOKIE)?.value}`};
    }

    it('is admin-only', async () => {
        expect((await app.inject({url: '/api/people-access', headers: await headersFor('zed')})).statusCode).toBe(404);
    });

    it('lists people in settings order with their shareable pages checked', async () => {
        const res = await app.inject({url: '/api/people-access', headers: await headersFor('anne')});
        const people = res.json().people;
        expect(people.map((p: {key: string}) => p.key)).toEqual(['anne', 'zed', 'all']);
        expect(people[1].allowedRoutes).toEqual(['/c-hub/revenue']);
        expect(people[2].allowedRoutes).toEqual([...SHAREABLE_ROUTES]);
    });

    it('saves exactly the checked shareable pages for every viewer', async () => {
        const headers = await headersFor('anne');
        const save = await app.inject({method: 'POST', url: '/api/people-access', headers,
            payload: {routes: {zed: ['/insights', '/settings'], anne: ['/insights']}}});
        expect(save.statusCode).toBe(200);
        const rows = (await pool.query('SELECT key, allowed_routes FROM users ORDER BY sort_order')).rows;
        expect(rows).toEqual([
            {key: 'anne', allowed_routes: ['*']},
            {key: 'zed', allowed_routes: ['/insights']},
            {key: 'all', allowed_routes: []},
        ]);
    });
});
