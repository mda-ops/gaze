import crypto from 'node:crypto';
import type pg from 'pg';
import {verifyPassword} from './passwords.js';

export interface SessionUser {
    key: string;
    name: string;
    title: string;
    role: 'admin' | 'viewer';
    username: string;
    photoUrl: string;
    allowedRoutes: string[];
}

// Same lifetime as the Python app's signed cookies.
export const SESSION_DAYS = 14;

// Open to every logged-in user: Welcome (Python app: viewer_allowed_routes) and Account.
const ALWAYS_ALLOWED = new Set(['/', '/account']);

// Pages a viewer can be given (Python app: SHAREABLE_ROUTES); '*' means all
// of them. Everything else (Settings, /transactions, ...) is admin-only.
// Keep in sync with SHAREABLE_PATHS in frontend/src/pages.ts.
export const SHAREABLE_ROUTES: readonly string[] = [
    '/',
    '/c-hub/executive-overview', '/c-hub/revenue', '/c-hub/chatter-revenue', '/c-hub/inactivity', '/c-hub/performance',
    '/c-hub/performance-2', '/c-hub/commissions', '/c-hub/transactions', '/c-hub/target-monitoring', '/c-hub/chatter-revenue-tier',
    '/c-hub', '/c-hub/compliance', '/c-hub/tickets', '/c-hub/marketing-ads', '/c-hub/models-socials', '/c-hub/of-new-fans',
    '/c-hub/ads-performance',
    '/revenue', '/chatters', '/creators', '/platforms',
    '/insights', '/revenue-tiers', '/weekly-report', '/monthly-report', '/ask',
    '/compliance-dash', '/marketing', '/models-socials', '/of-new-fan-growth', '/ads-performance', '/notion-tickets',
];
const SHAREABLE = new Set(SHAREABLE_ROUTES);

function tokenHash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// The users columns that make up a SessionUser; `table` is an optional alias.
function userColumns(table = ''): string {
    const t = table ? `${table}.` : '';
    return `${t}key, ${t}name, ${t}title, ${t}role, ${t}username, ${t}photo_url AS "photoUrl", ${t}allowed_routes AS "allowedRoutes"`;
}

// The login name may be the user's key, username or display name, any case,
// as in the Python app. Returns null for an unknown user or wrong password.
export async function authenticate(pool: pg.Pool, login: string, password: string): Promise<SessionUser | null> {
    const name = login.trim().toLowerCase();
    if (!name || !password) return null;
    const result = await pool.query<SessionUser & {password_hash: string | null}>(
        `SELECT ${userColumns()}, password_hash FROM users
         WHERE lower(key) = $1 OR lower(username) = $1 OR lower(name) = $1
         ORDER BY (lower(key) = $1) DESC, (lower(username) = $1) DESC
         LIMIT 1`,
        [name],
    );
    const row = result.rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) return null;
    const {password_hash: _ignored, ...user} = row;
    return user;
}

export async function createSession(pool: pg.Pool, userKey: string): Promise<{token: string; expiresAt: Date}> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await pool.query('INSERT INTO sessions (token_hash, user_key, expires_at) VALUES ($1, $2, $3)', [tokenHash(token), userKey, expiresAt]);
    return {token, expiresAt};
}

export async function sessionUser(pool: pg.Pool, token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const result = await pool.query<SessionUser>(
        `SELECT ${userColumns('u')}
         FROM sessions s JOIN users u ON u.key = s.user_key
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [tokenHash(token)],
    );
    return result.rows[0] ?? null;
}

export async function deleteSession(pool: pg.Pool, token: string | undefined): Promise<void> {
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
}

export function canOpen(user: SessionUser, route: string): boolean {
    if (user.role === 'admin') return true;
    if (ALWAYS_ALLOWED.has(route)) return true;
    if (!SHAREABLE.has(route)) return false;
    return user.allowedRoutes.includes('*') || user.allowedRoutes.includes(route);
}
