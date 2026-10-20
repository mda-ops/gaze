import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import type {FastifyInstance} from 'fastify';

// Serves the built React app (frontend/dist). Real files are served directly;
// any other GET outside /api is a client-side route and gets index.html so
// React Router can handle it. Misses under /api stay a JSON 404.
export async function registerStatic(fastify: FastifyInstance, publicDir: string): Promise<void> {
    if (!fs.existsSync(publicDir)) {
        console.warn(`[static] ${publicDir} not found: run "npm run build:frontend". Serving the API only.`);
        fastify.setNotFoundHandler((_request, reply) => reply.code(404).send({error: 'Not found.'}));
        return;
    }
    await fastify.register(fastifyStatic, {
        root: publicDir,
        index: 'index.html',
        cacheControl: false,
        setHeaders(res, filePath) {
            const p = filePath.replace(/\\/g, '/');
            // Vite fingerprints /assets/ file names, so their content never changes.
            if (p.includes('/assets/')) res.header('Cache-Control', 'public, max-age=31536000, immutable');
            else if (p.endsWith('.html')) res.header('Cache-Control', 'no-cache');
            else res.header('Cache-Control', 'public, max-age=3600');
        },
    });

    fastify.setNotFoundHandler((request, reply) => {
        if (request.raw.method !== 'GET' || request.url.startsWith('/api/')) {
            return reply.code(404).send({error: 'Not found.'});
        }
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html', publicDir);
    });
}
