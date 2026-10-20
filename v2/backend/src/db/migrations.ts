import type pg from 'pg';

// Schema of Gaze's own database. Migrations run in order at startup; each one
// runs once and is recorded in schema_migrations. Never edit a migration that
// has shipped: add a new one instead.
export const MIGRATIONS: {version: number; name: string; sql: string}[] = [
    {
        version: 1,
        name: 'users, sessions, site blocks, settings',
        sql: `
            -- People who can log in (the Python app's settings.json "shared_people").
            CREATE TABLE users (
                key            text PRIMARY KEY,
                name           text NOT NULL,
                title          text NOT NULL DEFAULT '',
                role           text NOT NULL CHECK (role IN ('admin', 'viewer')),
                username       text NOT NULL UNIQUE,
                email          text NOT NULL DEFAULT '',
                photo_url      text NOT NULL DEFAULT '',
                -- 'pbkdf2_sha256$<salt>$<hex digest>', the Python app's format,
                -- so existing passwords keep working.
                password_hash  text,
                -- Pages a viewer may open; '{*}' means every page. Admins see everything.
                allowed_routes text[] NOT NULL DEFAULT '{}',
                created_at     timestamptz NOT NULL DEFAULT now(),
                updated_at     timestamptz NOT NULL DEFAULT now()
            );

            -- Login sessions. The cookie carries the token; only its SHA-256
            -- is stored, so a database leak does not leak live sessions.
            CREATE TABLE sessions (
                token_hash  text PRIMARY KEY,
                user_key    text NOT NULL REFERENCES users (key) ON DELETE CASCADE,
                created_at  timestamptz NOT NULL DEFAULT now(),
                expires_at  timestamptz NOT NULL
            );
            CREATE INDEX sessions_user_key ON sessions (user_key);

            -- Admin-editable text blocks shown at the top of pages.
            CREATE TABLE site_blocks (
                id          text PRIMARY KEY,
                page        text NOT NULL,
                title       text NOT NULL DEFAULT '',
                body        text NOT NULL DEFAULT '',
                style       text NOT NULL DEFAULT 'note',
                enabled     boolean NOT NULL DEFAULT true,
                sort_order  integer NOT NULL DEFAULT 0
            );
            CREATE INDEX site_blocks_page ON site_blocks (page, sort_order);

            -- Every other setting (thresholds, commission_rules,
            -- operating_expenses, ...), one row per settings.json key.
            CREATE TABLE app_settings (
                key         text PRIMARY KEY,
                value       jsonb NOT NULL,
                updated_at  timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        version: 2,
        name: 'profile photos',
        sql: `
            -- Photos uploaded on the Account page (the Python app saved them as
            -- files, which a redeploy deletes).
            CREATE TABLE user_photos (
                user_key      text PRIMARY KEY REFERENCES users (key) ON DELETE CASCADE ON UPDATE CASCADE,
                file_name     text NOT NULL,
                content_type  text NOT NULL,
                data          bytea NOT NULL,
                updated_at    timestamptz NOT NULL DEFAULT now()
            );
        `,
    },
    {
        version: 3,
        name: 'users order',
        sql: `
            -- The order of people in the Python app's settings, used by People Access.
            ALTER TABLE users ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
        `,
    },
    {
        version: 4,
        name: 'site block list position',
        sql: `
            -- Python keeps blocks in a list: equal sort_order values keep list
            -- (creation) order. New rows get the next number.
            ALTER TABLE site_blocks ADD COLUMN list_position bigserial;
        `,
    },
];

// Arbitrary constant: serialises concurrent startups (e.g. two Railway
// replicas) so a migration never runs twice.
const MIGRATION_LOCK_ID = 470_115;

export async function runMigrations(pool: pg.Pool): Promise<number[]> {
    const client = await pool.connect();
    const applied: number[] = [];
    try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version     integer PRIMARY KEY,
                name        text NOT NULL,
                applied_at  timestamptz NOT NULL DEFAULT now()
            )`);
        const done = new Set((await client.query<{version: number}>('SELECT version FROM schema_migrations')).rows.map(r => r.version));
        for (const migration of MIGRATIONS) {
            if (done.has(migration.version)) continue;
            await client.query('BEGIN');
            try {
                await client.query(migration.sql);
                await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
                await client.query('COMMIT');
                applied.push(migration.version);
            } catch (e) {
                await client.query('ROLLBACK');
                throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${(e as Error).message}`);
            }
        }
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
        client.release();
    }
    return applied;
}
