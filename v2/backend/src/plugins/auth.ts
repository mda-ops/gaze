import cookie from '@fastify/cookie';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import fp from 'fastify-plugin';
import type pg from 'pg';
import {canOpen, sessionUser, type SessionUser} from '../lib/auth.js';

export const SESSION_COOKIE = 'gaze_session';

declare module 'fastify' {
    interface FastifyInstance {
        // Gaze's own database; null when GAZE_DATABASE_URL is not configured.
        gazePool: pg.Pool | null;
    }
    interface FastifyRequest {
        user: SessionUser | null;
    }
}

// API routes reachable without a session.
const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/login']);

async function authPlugin(fastify: FastifyInstance) {
    await fastify.register(cookie);
    fastify.decorateRequest('user', null);

    // Every /api route needs a logged-in user, except the public ones.
    fastify.addHook('preHandler', async (request, reply) => {
        const path = request.routeOptions.url ?? request.url;
        if (!path.startsWith('/api/') || PUBLIC_ROUTES.has(path)) return;
        if (!fastify.gazePool) {
            return reply.code(503).send({error: 'Gaze database is not configured.'});
        }
        request.user = await sessionUser(fastify.gazePool, request.cookies[SESSION_COOKIE]);
        if (!request.user) {
            return reply.code(401).send({error: 'Not logged in.'});
        }
    });
}

export default fp(authPlugin, {name: 'gaze-auth'});

// Use in a route that serves data for one page, e.g. requirePage('/c-hub/revenue'):
// a viewer may only load data for pages they are allowed to open. Answers 404,
// like the Python app, so hidden pages are not revealed.
export function requirePage(route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        if (!request.user || !canOpen(request.user, route)) {
            return reply.code(404).send({error: 'Not found.'});
        }
    };
}
