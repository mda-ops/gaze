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

describe.skipIf(!process.env.GAZE_DATABASE_URL)('account routes', () => {
    const schema = `test_account_${process.pid}`;
    const pool = new pg.Pool({...gazePoolConfig(process.env.GAZE_DATABASE_URL ?? ''), options: `-c search_path=${schema}`, max: 3});
    let app: FastifyInstance;
    let headers: Record<string, string>;

    beforeAll(async () => {
        await pool.query(`CREATE SCHEMA ${schema}`);
        await runMigrations(pool);
        await pool.query(
            `INSERT INTO users (key, name, title, role, username, password_hash) VALUES
             ('test-viewer', 'Test', 'Shared Viewer', 'viewer', 'test', $1),
             ('other', 'Other', '', 'viewer', 'taken', NULL)`,
            [hashPassword('old-password')],
        );
        app = await buildApp({gazePool: pool});
        const login = await app.inject({method: 'POST', url: '/api/auth/login', payload: {username: 'test', password: 'old-password'}});
        headers = {cookie: `${SESSION_COOKIE}=${login.cookies.find(c => c.name === SESSION_COOKIE)?.value}`};
    });

    afterAll(async () => {
        await app?.close();
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.end();
    });

    const profile = async () => (await app.inject({url: '/api/account', headers})).json().profile;
    const save = (payload: object) => app.inject({method: 'POST', url: '/api/account', headers, payload: {photo: null, ...payload}});

    it('saves the profile, filling an empty name and username like the Python app', async () => {
        expect((await save({name: '  ', username: '', email: ' a@b.c ', photoUrl: ''})).statusCode).toBe(200);
        expect(await profile()).toMatchObject({name: 'Test-Viewer', username: 'test-viewer', email: 'a@b.c', photoUrl: ''});
    });

    it('refuses a username another person uses', async () => {
        expect((await save({name: 'Test', username: 'taken', email: '', photoUrl: ''})).statusCode).toBe(400);
    });

    it('stores an uploaded photo and serves it', async () => {
        const data = Buffer.from('fake image').toString('base64');
        expect((await save({name: 'Test', username: 'test', email: '', photoUrl: 'ignored', photo: {fileName: 'Me.JPG', data}})).statusCode).toBe(200);
        const {photoUrl} = await profile();
        expect(photoUrl).toBe('/api/account/photos/test-viewer.jpg');
        const photo = await app.inject({url: photoUrl, headers});
        expect(photo.headers['content-type']).toBe('image/jpeg');
        expect(photo.body).toBe('fake image');
    });

    it('changes the password only when both boxes match', async () => {
        const change = (newPassword: string, confirmPassword: string) =>
            app.inject({method: 'POST', url: '/api/account/password', headers, payload: {newPassword, confirmPassword}});
        expect((await change('', '')).statusCode).toBe(400);
        expect((await change('new-password', 'other')).statusCode).toBe(400);
        expect((await change('new-password', 'new-password')).statusCode).toBe(200);
        const login = await app.inject({method: 'POST', url: '/api/auth/login', payload: {username: 'test', password: 'new-password'}});
        expect(login.statusCode).toBe(200);
    });
});
