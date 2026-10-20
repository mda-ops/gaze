import Fastify, {type FastifyInstance} from 'fastify';
import type pg from 'pg';
import {gazeDatabaseConfigured, getGazePool} from './db/gaze-db.js';
import authPlugin from './plugins/auth.js';
import accountRoutes from './routes/account.routes.js';
import authRoutes from './routes/auth.routes.js';
import healthRoutes from './routes/health.routes.js';
import pagesRoutes from './routes/pages.routes.js';
import peopleAccessRoutes from './routes/people-access.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import siteBlockRoutes from './routes/site-blocks.routes.js';
import {registerStatic} from './plugins/static.js';

export interface BuildAppOptions {
    // Tests pass their own pool; otherwise GAZE_DATABASE_URL decides.
    gazePool?: pg.Pool | null;
    // The built frontend (frontend/dist); omitted in tests.
    publicDir?: string;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
    const fastify = Fastify({logger: false, trustProxy: true});

    const gazePool = options.gazePool !== undefined ? options.gazePool : (gazeDatabaseConfigured() ? getGazePool() : null);
    fastify.decorate('gazePool', gazePool);

    // Unexpected errors: logged (Railway shows stdout/stderr), answered with a
    // generic message so database details never reach the browser.
    fastify.setErrorHandler((error: Error & {statusCode?: number}, request, reply) => {
        const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
        if (status >= 500) console.error(`[error] ${request.method} ${request.url}:`, error);
        return reply.code(status).send({error: status >= 500 ? 'Internal Server Error' : error.message});
    });

    await fastify.register(authPlugin);
    await fastify.register(healthRoutes);
    await fastify.register(authRoutes);
    await fastify.register(accountRoutes);
    await fastify.register(pagesRoutes);
    await fastify.register(peopleAccessRoutes);
    await fastify.register(siteBlockRoutes);
    await fastify.register(settingsRoutes);
    if (options.publicDir) await registerStatic(fastify, options.publicDir);

    return fastify;
}
