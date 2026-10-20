import type {FastifyInstance} from 'fastify';
import {getFlowPool} from '../db/flow-db.js';
import {gazeDatabaseConfigured, getGazePool} from '../db/gaze-db.js';

type GazeDatabaseStatus = {configured: false} | {configured: true; reachable: boolean; error?: string};

async function gazeDatabaseStatus(): Promise<GazeDatabaseStatus> {
    if (!gazeDatabaseConfigured()) return {configured: false};
    try {
        await getGazePool().query('SELECT 1');
        return {configured: true, reachable: true};
    } catch (e) {
        return {configured: true, reachable: false, error: (e as Error).message};
    }
}

export default async function healthRoutes(fastify: FastifyInstance) {
    // Railway's deploy health check uses this route. A deploy only goes live
    // when Flow's database is reachable through a read-only session and, if
    // Gaze's own database is configured, that one is reachable too.
    fastify.get('/api/health', async (_request, reply) => {
        const gazeDatabase = await gazeDatabaseStatus();
        const gazeOk = !gazeDatabase.configured || gazeDatabase.reachable;
        try {
            const result = await getFlowPool().query<{read_only: string}>(
                'SELECT current_setting(\'default_transaction_read_only\') AS read_only',
            );
            const readOnly = result.rows[0]?.read_only === 'on';
            const ok = readOnly && gazeOk;
            if (!ok) reply.code(503);
            return {ok, flowDatabase: {reachable: true, readOnly}, gazeDatabase};
        } catch (e) {
            reply.code(503);
            return {ok: false, flowDatabase: {reachable: false, error: (e as Error).message}, gazeDatabase};
        }
    });
}
