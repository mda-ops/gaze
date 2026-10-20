import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {hashPassword} from '../lib/passwords.js';

// The Account page: every logged-in user edits their own profile and password
// (Python app: account, save_account, save_account_password).

const PHOTO_TYPES: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

const ProfileBody = z.object({
    name: z.string().max(200),
    username: z.string().max(200),
    email: z.string().max(320),
    photoUrl: z.string().max(2000),
    // An uploaded photo file, base64-encoded by the browser.
    photo: z.object({fileName: z.string().max(300), data: z.string()}).nullable().default(null),
});

const PasswordBody = z.object({
    newPassword: z.string().max(500),
    confirmPassword: z.string().max(500),
});

// Python's str.title(): "test-viewer" -> "Test-Viewer".
function pyTitle(text: string): string {
    return text.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
}

export default async function accountRoutes(fastify: FastifyInstance) {
    fastify.get('/api/account', async request => {
        const result = await fastify.gazePool!.query(
            `SELECT key, name, title, role, username, email, photo_url AS "photoUrl" FROM users WHERE key = $1`, [request.user!.key]);
        return {profile: result.rows[0]};
    });

    // Photos are 10 MB at most once encoded.
    fastify.post('/api/account', {bodyLimit: 10 * 1024 * 1024}, async (request, reply) => {
        const body = ProfileBody.safeParse(request.body);
        if (!body.success) return reply.code(400).send({error: 'Invalid profile.'});
        const key = request.user!.key;
        const pool = fastify.gazePool!;
        let photoUrl = body.data.photoUrl.trim();
        if (body.data.photo?.fileName) {
            // Any other file type is saved as .png, as in the Python app.
            const dot = body.data.photo.fileName.lastIndexOf('.');
            const given = dot > 0 ? body.data.photo.fileName.slice(dot).toLowerCase() : '';
            const suffix = PHOTO_TYPES[given] ? given : '.png';
            const fileName = `${key}${suffix}`;
            await pool.query(
                `INSERT INTO user_photos (user_key, file_name, content_type, data) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_key) DO UPDATE SET file_name = $2, content_type = $3, data = $4, updated_at = now()`,
                [key, fileName, PHOTO_TYPES[suffix], Buffer.from(body.data.photo.data, 'base64')]);
            photoUrl = `/api/account/photos/${encodeURIComponent(fileName)}`;
        }
        const name = body.data.name.trim() || pyTitle(key);
        const username = body.data.username.trim() || name.toLowerCase().replace(/ /g, '.');
        try {
            await pool.query(
                'UPDATE users SET name = $2, username = $3, email = $4, photo_url = $5, updated_at = now() WHERE key = $1',
                [key, name, username, body.data.email.trim(), photoUrl]);
        } catch (e) {
            // Usernames are unique in v2 (the Python app allowed duplicates).
            if ((e as {code?: string}).code === '23505') return reply.code(400).send({error: 'That username is already used by another person.'});
            throw e;
        }
        return {saved: true};
    });

    fastify.post('/api/account/password', async (request, reply) => {
        const body = PasswordBody.safeParse(request.body);
        if (!body.success || !body.data.newPassword || body.data.newPassword !== body.data.confirmPassword) {
            return reply.code(400).send({error: 'enter the same password in both boxes.'});
        }
        await fastify.gazePool!.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE key = $1',
            [request.user!.key, hashPassword(body.data.newPassword)]);
        return {saved: true};
    });

    fastify.get('/api/account/photos/:file', async (request, reply) => {
        const {file} = request.params as {file: string};
        const result = await fastify.gazePool!.query<{content_type: string; data: Buffer}>(
            'SELECT content_type, data FROM user_photos WHERE file_name = $1', [file]);
        const photo = result.rows[0];
        if (!photo) return reply.code(404).send({error: 'Not found.'});
        return reply.type(photo.content_type).send(photo.data);
    });
}
