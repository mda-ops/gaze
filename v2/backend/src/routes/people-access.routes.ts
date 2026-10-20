import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {SHAREABLE_ROUTES} from '../lib/auth.js';
import {requirePage} from '../plugins/auth.js';

// People Access (/people-access, also at /permission-groups): which pages each
// viewer may open (Python app: people_access, save_people_access).

const SaveBody = z.object({
    // Checked pages per person key.
    routes: z.record(z.string(), z.array(z.string().max(200)).max(200)),
});

// Python: viewer_allowed_routes, the pages a person's checkboxes show as checked.
function allowedPages(stored: string[]): string[] {
    if (stored.length === 1 && stored[0] === '*') return [...SHAREABLE_ROUTES];
    return stored.filter(path => SHAREABLE_ROUTES.includes(path));
}

export default async function peopleAccessRoutes(fastify: FastifyInstance) {
    const adminOnly = {preHandler: requirePage('/people-access')};

    fastify.get('/api/people-access', adminOnly, async () => {
        const result = await fastify.gazePool!.query<{key: string; name: string; title: string; role: string; allowed_routes: string[]}>(
            'SELECT key, name, title, role, allowed_routes FROM users ORDER BY sort_order, key');
        return {
            people: result.rows.map(u => ({
                key: u.key, name: u.name, title: u.title, role: u.role,
                allowedRoutes: u.role === 'admin' ? [] : allowedPages(u.allowed_routes),
            })),
        };
    });

    // Every viewer gets exactly the checked pages (none checked: none); admins are left alone.
    fastify.post('/api/people-access', adminOnly, async (request, reply) => {
        const body = SaveBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({error: 'Invalid page access.'});
        const pool = fastify.gazePool!;
        const viewers = await pool.query<{key: string}>("SELECT key FROM users WHERE role <> 'admin'");
        for (const {key} of viewers.rows) {
            const allowed = (body.data.routes[key] ?? []).filter(path => SHAREABLE_ROUTES.includes(path));
            await pool.query('UPDATE users SET allowed_routes = $2, updated_at = now() WHERE key = $1', [key, allowed]);
        }
        return {saved: true};
    });
}
