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
import {SESSION_COOKIE} from '../plugins/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(here, '..', '..', '..', '.env'), quiet: true});

describe.skipIf(!process.env.GAZE_DATABASE_URL)('site block routes', () => {
    const schema = `test_blocks_${process.pid}`;
    const pool = new pg.Pool({...gazePoolConfig(process.env.GAZE_DATABASE_URL ?? ''), options: `-c search_path=${schema}`, max: 3});
    let app: FastifyInstance;
    let admin: Record<string, string>;
    let viewer: Record<string, string>;

    beforeAll(async () => {
        await pool.query(`CREATE SCHEMA ${schema}`);
        await runMigrations(pool);
        await pool.query(
            `INSERT INTO users (key, name, title, role, username, password_hash, allowed_routes) VALUES
             ('anne', 'Anne', 'Admin', 'admin', 'anne', $1, '{*}'),
             ('zed', 'Zed', 'CEO', 'viewer', 'zed', $1, '{/insights}')`,
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

    const save = (payload: object) => app.inject({method: 'POST', url: '/api/edit-site', headers: admin,
        payload: {id: '', title: '', body: '', style: 'note', enabled: true, ...payload}});
    const shown = async (page: string, headers = viewer) =>
        (await app.inject({url: `/api/site-blocks?page=${encodeURIComponent(page)}`, headers})).json().blocks;

    it('is admin-only to edit', async () => {
        expect((await app.inject({url: '/api/edit-site', headers: viewer})).statusCode).toBe(404);
    });

    it('adds blocks at the end of their page, cleans their text and shows only visible ones', async () => {
        const first = (await save({page: '/insights', title: ' First ', body: '<p>Hi<script>x</script></p>'})).json();
        await save({page: '/insights', title: '', body: 'second', enabled: false});
        await save({page: '/nowhere', title: 'Fallback'});
        expect(first.page).toBe('/insights');
        expect(await shown('/insights')).toEqual([{id: first.id, title: 'First', body: '<p>Hi</p>', style: 'note'}]);
        // An unknown page falls back to Welcome.
        expect((await shown('/')).map((b: {title: string}) => b.title)).toEqual(['Fallback']);
        const all = (await app.inject({url: '/api/edit-site', headers: admin})).json().blocks;
        expect(all.map((b: {page: string; title: string; sort_order: number}) => [b.page, b.title, b.sort_order]))
            .toEqual([['/', 'Fallback', 1], ['/insights', 'First', 1], ['/insights', 'Untitled block', 2]]);
    });

    it('hides blocks on pages the viewer cannot open', async () => {
        await save({page: '/revenue', title: 'Secret'});
        expect(await shown('/revenue')).toEqual([]);
        expect(await shown('/revenue', admin)).toHaveLength(1);
    });

    it('moves a block within its page and deletes it', async () => {
        const all = (await app.inject({url: '/api/edit-site', headers: admin})).json().blocks;
        const second = all.find((b: {title: string}) => b.title === 'Untitled block');
        await app.inject({method: 'POST', url: '/api/edit-site', headers: admin, payload: {...second, enabled: true}});
        await app.inject({method: 'POST', url: '/api/edit-site/move', headers: admin, payload: {id: second.id, direction: 'up'}});
        expect((await shown('/insights')).map((b: {title: string}) => b.title)).toEqual(['Untitled block', 'First']);
        await app.inject({method: 'POST', url: '/api/edit-site/delete', headers: admin, payload: {id: second.id}});
        expect((await shown('/insights')).map((b: {title: string}) => b.title)).toEqual(['First']);
    });
});
