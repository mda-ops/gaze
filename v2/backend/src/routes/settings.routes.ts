import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {todayIn} from '../lib/period.js';
import {loadSettings} from '../lib/settings.js';
import {requirePage} from '../plugins/auth.js';

// Settings and Data Sources (admins). Only the settings a page reads are
// editable (the Python app's form also held import-only keys and thresholds
// nothing read), and Data Sources keeps only its links: the Python app's
// imports never reached a page (docs/rewrite/01-intended-differences.md).

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

function validTimeZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat('en', {timeZone: zone});
        return true;
    } catch {
        return false;
    }
}

const percent = z.number().finite().min(0).max(1000);

// In the Python app's form order.
const SettingsBody = z.object({
    reporting_week_start: z.enum(WEEKDAYS),
    default_currency: z.enum(['EUR', 'USD']),
    timezone: z.string().trim().refine(validTimeZone, 'Unknown timezone.'),
    unlock_threshold: z.number().finite().min(0),
    anomaly_revenue_drop_pct: percent,
    anomaly_revenue_spike_pct: percent,
    revenue_catcher_base_url: z.string().trim().url().refine(url => /^https?:\/\//.test(url), 'Use an http(s) address.'),
});
type SettingsForm = z.infer<typeof SettingsBody>;
const FIELDS = Object.keys(SettingsBody.shape) as (keyof SettingsForm)[];

const DEFAULT_FLOW_URL = 'https://revenuecatcher-production.up.railway.app';
// The Python app's Revenue Catcher start date default, kept for the inactivity link.
const INACTIVITY_FROM = '2026-05-20';

export default async function settingsRoutes(fastify: FastifyInstance) {
    fastify.get('/api/settings', {preHandler: requirePage('/settings')}, async () => {
        const settings = await loadSettings(fastify.gazePool);
        const values = Object.fromEntries(FIELDS.map(key => [key, settings[key] ?? (key === 'revenue_catcher_base_url' ? DEFAULT_FLOW_URL : '')]));
        return {values};
    });

    fastify.post('/api/settings', {preHandler: requirePage('/settings')}, async (request, reply) => {
        const body = SettingsBody.safeParse(request.body);
        if (!body.success) {
            const issue = body.error.issues[0];
            return reply.code(400).send({error: `${String(issue?.path[0] ?? 'Settings')}: ${issue?.message ?? 'invalid value.'}`});
        }
        const client = await fastify.gazePool!.connect();
        try {
            await client.query('BEGIN');
            for (const key of FIELDS) {
                await client.query(
                    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
                    [key, JSON.stringify(body.data[key])]);
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        return {saved: true};
    });

    // Shortcuts to the external sources Gaze is built on.
    fastify.get('/api/data-sources', {preHandler: requirePage('/data-sources')}, async () => {
        const settings = await loadSettings(fastify.gazePool);
        const flow = String(settings.revenue_catcher_base_url ?? DEFAULT_FLOW_URL).replace(/\/+$/, '');
        const today = todayIn(settings.timezone);
        return {
            links: [
                {label: 'Master Sheet', note: 'MD Master Revenue DB', url: 'https://docs.google.com/spreadsheets/d/1m9dt-YmwTQM58JdXDfVslzxysnSUEWFjlGU3A4FxasQ/edit?gid=759629051#gid=759629051'},
                {label: 'Looker Studio', note: 'Looker Studio report', url: 'https://datastudio.google.com/u/0/reporting/c53f9edc-30ff-4f99-b90e-c0f651eed59d/page/p_huryau5b4d/edit'},
                {label: 'Flow', note: 'Revenue Catcher manager', url: `${flow}/manager`},
                {label: 'Inactivity page', note: `Flow inactivity, ${INACTIVITY_FROM} to today`, url: `${flow}/manager/inactivity?from=${INACTIVITY_FROM}&to=${today}`},
            ],
        };
    });
}
