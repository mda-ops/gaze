import path from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import {buildApp} from './app.js';
import {closeFlowPool} from './db/flow-db.js';
import {closeGazePool, gazeDatabaseConfigured, getGazePool} from './db/gaze-db.js';
import {runMigrations} from './db/migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Compiled to v2/backend/dist/server.js; the .env file lives in v2/.
dotenv.config({path: path.join(__dirname, '..', '..', '.env'), quiet: true});

const PORT = process.env.PORT ? Number(process.env.PORT) : 8767;

async function main() {
    // Schema first, so no request ever sees a half-migrated database.
    if (gazeDatabaseConfigured()) {
        const applied = await runMigrations(getGazePool());
        if (applied.length) console.log(`[gaze-db] Applied migrations ${applied.join(', ')}`);
    } else {
        console.warn('[gaze-db] GAZE_DATABASE_URL is not set: running without Gaze\'s own database');
    }

    const fastify = await buildApp({publicDir: path.join(__dirname, '..', '..', 'frontend', 'dist')});
    await fastify.listen({port: PORT, host: '0.0.0.0'});
    console.log(`Gaze running at http://localhost:${PORT}`);

    async function shutdown() {
        await fastify.close();
        await closeFlowPool();
        await closeGazePool();
        process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
