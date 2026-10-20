import type pg from 'pg';
import {SHAREABLE_ROUTES} from './auth.js';

// Converts the Python app's effective settings (v2/tools/export_settings.py)
// into rows for Gaze's own database.

export interface UserRecord {
    key: string;
    name: string;
    title: string;
    role: 'admin' | 'viewer';
    username: string;
    email: string;
    photoUrl: string;
    passwordHash: string | null;
    allowedRoutes: string[];
    sortOrder: number;
}

export interface SiteBlockRecord {
    id: string;
    page: string;
    title: string;
    body: string;
    style: string;
    enabled: boolean;
    sortOrder: number;
}

export interface SettingsRecords {
    users: UserRecord[];
    siteBlocks: SiteBlockRecord[];
    settings: Record<string, unknown>;
}

// Keys stored elsewhere (users, site_blocks) or deliberately not imported:
// v2 never calls Revenue Catcher's HTTP API, so its key is a secret with no use.
const NOT_STORED_AS_SETTINGS = new Set(['shared_people', 'site_blocks', 'revenue_catcher_api_key']);

function text(value: unknown, fallback = ''): string {
    return value === undefined || value === null ? fallback : String(value);
}

export function settingsToRecords(settings: Record<string, unknown>): SettingsRecords {
    const people = (settings.shared_people ?? {}) as Record<string, Record<string, unknown>>;
    // A person without their own page list gets the default one (Python app:
    // default_viewer_routes): settings.viewer_allowed_routes, else every shareable page.
    const defaultRoutes = Array.isArray(settings.viewer_allowed_routes)
        ? settings.viewer_allowed_routes.map(String).filter(path => SHAREABLE_ROUTES.includes(path))
        : ['*'];
    const users: UserRecord[] = Object.entries(people).map(([key, profile], index) => {
        // Same fallbacks as the Python app's person_profile().
        const name = text(profile.name, 'Anne');
        const role = text(profile.role, key === 'anne' ? 'admin' : 'viewer') === 'admin' ? 'admin' : 'viewer';
        return {
            key,
            name,
            title: text(profile.title, role === 'admin' ? 'Admin' : 'Shared Viewer'),
            role,
            username: text(profile.username, name.toLowerCase().replace(/ /g, '.')),
            email: text(profile.email),
            photoUrl: text(profile.photo_url),
            passwordHash: profile.password_hash ? String(profile.password_hash) : null,
            allowedRoutes: Array.isArray(profile.allowed_routes) ? profile.allowed_routes.map(String) : defaultRoutes,
            sortOrder: index,
        };
    });

    const blocks = Array.isArray(settings.site_blocks) ? settings.site_blocks as Record<string, unknown>[] : [];
    const siteBlocks: SiteBlockRecord[] = blocks.map(block => ({
        id: text(block.id),
        page: text(block.page, '/'),
        title: text(block.title),
        body: text(block.body),
        style: text(block.style, 'note'),
        enabled: block.enabled === undefined ? true : Boolean(block.enabled),
        sortOrder: Number(block.order ?? 0) || 0,
    }));

    const rest = Object.fromEntries(Object.entries(settings).filter(([key]) => !NOT_STORED_AS_SETTINGS.has(key)));
    return {users, siteBlocks, settings: rest};
}

// Replaces Gaze's users, site blocks and settings with the given records, in
// one transaction. Users missing from the import are removed (with their
// sessions); users kept keep their sessions.
export async function importSettingsRecords(pool: pg.Pool, records: SettingsRecords): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const u of records.users) {
            await client.query(
                `INSERT INTO users (key, name, title, role, username, email, photo_url, password_hash, allowed_routes, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (key) DO UPDATE SET
                     name = EXCLUDED.name, title = EXCLUDED.title, role = EXCLUDED.role,
                     username = EXCLUDED.username, email = EXCLUDED.email, photo_url = EXCLUDED.photo_url,
                     password_hash = EXCLUDED.password_hash, allowed_routes = EXCLUDED.allowed_routes,
                     sort_order = EXCLUDED.sort_order, updated_at = now()`,
                [u.key, u.name, u.title, u.role, u.username, u.email, u.photoUrl, u.passwordHash, u.allowedRoutes, u.sortOrder],
            );
        }
        await client.query('DELETE FROM users WHERE NOT (key = ANY($1))', [records.users.map(u => u.key)]);

        await client.query('DELETE FROM site_blocks');
        for (const b of records.siteBlocks) {
            await client.query(
                'INSERT INTO site_blocks (id, page, title, body, style, enabled, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [b.id, b.page, b.title, b.body, b.style, b.enabled, b.sortOrder],
            );
        }

        await client.query('DELETE FROM app_settings');
        for (const [key, value] of Object.entries(records.settings)) {
            await client.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [key, JSON.stringify(value)]);
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
