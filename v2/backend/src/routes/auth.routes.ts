import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {authenticate, createSession, deleteSession} from '../lib/auth.js';
import {LoginLimiter} from '../lib/login-limiter.js';
import {SESSION_COOKIE} from '../plugins/auth.js';

const LoginBody = z.object({
    username: z.string().max(200),
    password: z.string().max(500),
});

export default async function authRoutes(fastify: FastifyInstance) {
    const limiter = new LoginLimiter();

    fastify.post('/api/auth/login', async (request, reply) => {
        const pool = fastify.gazePool;
        if (!pool) return reply.code(503).send({error: 'Gaze database is not configured.'});
        const body = LoginBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({error: 'Username and password are required.'});

        const limitKey = `${request.ip}|${body.data.username.trim().toLowerCase()}`;
        if (limiter.isBlocked(limitKey)) {
            return reply.code(429).send({error: 'Too many failed attempts. Try again in 15 minutes.'});
        }
        const user = await authenticate(pool, body.data.username, body.data.password);
        if (!user) {
            limiter.recordFailure(limitKey);
            return reply.code(401).send({error: 'Incorrect username or password.'});
        }
        limiter.recordSuccess(limitKey);

        const session = await createSession(pool, user.key);
        reply.setCookie(SESSION_COOKIE, session.token, {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            // HTTPS-only cookie when the request came in over HTTPS (Railway).
            secure: 'auto',
            expires: session.expiresAt,
        });
        return {user};
    });

    fastify.post('/api/auth/logout', async (request, reply) => {
        if (fastify.gazePool) await deleteSession(fastify.gazePool, request.cookies[SESSION_COOKIE]);
        reply.clearCookie(SESSION_COOKIE, {path: '/'});
        return reply.code(204).send();
    });

    fastify.get('/api/auth/me', async request => ({user: request.user}));
}
