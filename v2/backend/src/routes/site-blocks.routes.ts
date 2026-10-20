import crypto from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {canOpen, SHAREABLE_ROUTES} from '../lib/auth.js';
import {cleanRichText} from '../lib/rich-text.js';
import {requirePage} from '../plugins/auth.js';

// Edit Site: admin-written text blocks shown at the bottom of a page (Python
// app: render_site_blocks, edit_site, save/delete/move_site_block).

// Pages a block can be put on (Python app: editable_pages): every shareable page but Welcome.
const EDITABLE_PAGES = SHAREABLE_ROUTES.filter(path => path !== '/');

// Equal orders keep creation order, like the Python app's list.
const BLOCK_ORDER = 'sort_order, list_position';

const SaveBody = z.object({
    id: z.string().max(100),
    page: z.string().max(200),
    title: z.string().max(500),
    body: z.string().max(200_000),
    style: z.string().max(100),
    enabled: z.boolean(),
});
const IdBody = z.object({id: z.string().max(100)});
const MoveBody = z.object({id: z.string().max(100), direction: z.string().max(10)});

interface BlockRow {
    id: string; page: string; title: string; body: string; style: string; enabled: boolean; sort_order: number;
}

export default async function siteBlockRoutes(fastify: FastifyInstance) {
    const adminOnly = {preHandler: requirePage('/edit-site')};

    // The visible blocks of one page, for anyone who may open that page.
    fastify.get('/api/site-blocks', async request => {
        const page = String((request.query as Record<string, unknown>).page ?? '');
        if (!canOpen(request.user!, page)) return {blocks: []};
        const result = await fastify.gazePool!.query<BlockRow>(
            `SELECT id, title, body, style FROM site_blocks WHERE page = $1 AND enabled ORDER BY ${BLOCK_ORDER}`, [page]);
        return {
            blocks: result.rows.map(b => ({id: b.id, title: b.title.trim(), body: cleanRichText(b.body), style: b.style || 'note'})),
        };
    });

    // Every block for the editor, by page then order: the raw body, and the
    // cleaned body the editor starts from.
    fastify.get('/api/edit-site', adminOnly, async () => {
        const result = await fastify.gazePool!.query<BlockRow>(
            `SELECT id, page, title, body, style, enabled, sort_order FROM site_blocks ORDER BY page COLLATE "C", ${BLOCK_ORDER}`);
        return {blocks: result.rows.map(b => ({...b, cleanBody: cleanRichText(b.body)}))};
    });

    fastify.post('/api/edit-site', adminOnly, async (request, reply) => {
        const body = SaveBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({error: 'Invalid block.'});
        const pool = fastify.gazePool!;
        const page = EDITABLE_PAGES.includes(body.data.page) ? body.data.page : '/';
        const values = [body.data.title.trim() || 'Untitled block', body.data.body.trim(), body.data.style, body.data.enabled];
        const existing = await pool.query('SELECT 1 FROM site_blocks WHERE id = $1', [body.data.id.trim()]);
        let id = body.data.id.trim();
        if (existing.rowCount) {
            await pool.query('UPDATE site_blocks SET page = $2, title = $3, body = $4, style = $5, enabled = $6 WHERE id = $1', [id, page, ...values]);
        } else {
            // A new block goes last on its page.
            id = crypto.randomBytes(6).toString('hex');
            await pool.query(
                `INSERT INTO site_blocks (id, page, title, body, style, enabled, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, (SELECT count(*) + 1 FROM site_blocks WHERE page = $2))`,
                [id, page, ...values]);
        }
        return {id, page};
    });

    fastify.post('/api/edit-site/delete', adminOnly, async (request, reply) => {
        const body = IdBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({error: 'Invalid block.'});
        await fastify.gazePool!.query('DELETE FROM site_blocks WHERE id = $1', [body.data.id]);
        return {deleted: true};
    });

    // Swaps the block's order with its neighbour on the same page.
    fastify.post('/api/edit-site/move', adminOnly, async (request, reply) => {
        const body = MoveBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({error: 'Invalid block.'});
        const client = await fastify.gazePool!.connect();
        try {
            await client.query('BEGIN');
            const block = (await client.query<BlockRow>('SELECT page FROM site_blocks WHERE id = $1 FOR UPDATE', [body.data.id])).rows[0];
            if (block) {
                const samePage = (await client.query<BlockRow>(
                    `SELECT id, sort_order FROM site_blocks WHERE page = $1 ORDER BY ${BLOCK_ORDER} FOR UPDATE`, [block.page])).rows;
                const index = samePage.findIndex(b => b.id === body.data.id);
                const swap = body.data.direction === 'up' ? index - 1 : index + 1;
                if (swap >= 0 && swap < samePage.length) {
                    await client.query('UPDATE site_blocks SET sort_order = $2 WHERE id = $1', [samePage[index].id, samePage[swap].sort_order]);
                    await client.query('UPDATE site_blocks SET sort_order = $2 WHERE id = $1', [samePage[swap].id, samePage[index].sort_order]);
                }
            }
            await client.query('COMMIT');
            return {page: block?.page ?? null};
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    });
}
