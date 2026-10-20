import {describe, expect, it} from 'vitest';
import {settingsToRecords} from './settings-import.js';

describe('settingsToRecords', () => {
    const settings = {
        timezone: 'Europe/Amsterdam',
        unlock_threshold: 199,
        revenue_catcher_api_key: 'secret',
        commission_rules: [{name: 'Default', creator_pct: 30}],
        shared_people: {
            anne: {name: 'Anne', role: 'admin', username: 'anne', password_hash: 'pbkdf2_sha256$s$d', allowed_routes: ['*']},
            damian: {name: 'Damian', title: 'CEO', role: 'viewer', username: 'damian', allowed_routes: ['/c-hub', '/c-hub/revenue']},
            bare: {},
        },
        site_blocks: [{id: 'abc', page: '/c-hub', title: 'Hi', body: '<p>x</p>', order: 2}],
    };
    const records = settingsToRecords(settings);

    it('maps people to users with the Python app fallbacks', () => {
        expect(records.users.find(u => u.key === 'anne')).toMatchObject({role: 'admin', passwordHash: 'pbkdf2_sha256$s$d', allowedRoutes: ['*']});
        expect(records.users.find(u => u.key === 'damian')).toMatchObject({title: 'CEO', role: 'viewer', passwordHash: null});
        // person_profile(): missing name is "Anne", non-anne keys default to viewer.
        expect(records.users.find(u => u.key === 'bare')).toMatchObject({name: 'Anne', role: 'viewer', title: 'Shared Viewer', username: 'anne', allowedRoutes: ['*']});
        expect(records.users.map(u => u.sortOrder)).toEqual(records.users.map((_, i) => i));
    });

    it('gives people without a page list the configured default list', () => {
        const users = settingsToRecords({
            viewer_allowed_routes: ['/c-hub/revenue', '/transactions', '/insights'],
            shared_people: {bare: {}},
        }).users;
        // Only shareable pages count, as in the Python app.
        expect(users[0].allowedRoutes).toEqual(['/c-hub/revenue', '/insights']);
    });

    it('maps site blocks, defaulting enabled and style', () => {
        expect(records.siteBlocks).toEqual([{id: 'abc', page: '/c-hub', title: 'Hi', body: '<p>x</p>', style: 'note', enabled: true, sortOrder: 2}]);
    });

    it('keeps other settings but never the Revenue Catcher API key', () => {
        expect(records.settings).toEqual({
            timezone: 'Europe/Amsterdam',
            unlock_threshold: 199,
            commission_rules: [{name: 'Default', creator_pct: 30}],
        });
    });
});
