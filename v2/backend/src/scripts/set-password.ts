// Set a person's password in Gaze's own database (GAZE_DATABASE_URL).
//
//   npm run set-password -- <key or username>
//
// Asks for the new password. Logs that person out everywhere.
import path from 'node:path';
import readline from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import {closeGazePool, getGazePool} from '../db/gaze-db.js';
import {runMigrations} from '../db/migrations.js';
import {hashPassword} from '../lib/passwords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(__dirname, '..', '..', '..', '.env'), quiet: true});

async function main() {
    const login = process.argv[2]?.trim().toLowerCase();
    if (!login) throw new Error('Usage: npm run set-password -- <key or username>');
    const pool = getGazePool();
    await runMigrations(pool);
    const user = (await pool.query<{key: string}>('SELECT key FROM users WHERE lower(key) = $1 OR lower(username) = $1', [login])).rows[0];
    if (!user) throw new Error(`No person "${login}". Import the settings first (npm run import-settings).`);

    const prompt = readline.createInterface({input: process.stdin, output: process.stdout});
    const password = await prompt.question(`New password for ${user.key}: `);
    prompt.close();
    if (password.length < 8) throw new Error('Use at least 8 characters.');

    await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE key = $1', [user.key, hashPassword(password)]);
    await pool.query('DELETE FROM sessions WHERE user_key = $1', [user.key]);
    console.log(`Password set for ${user.key}.`);
    await closeGazePool();
}

main().catch(e => {
    console.error(e.message);
    process.exit(1);
});
