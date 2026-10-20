// Import the Python app's settings into Gaze's own database.
//
//   1. Export (repo root):  .venv/Scripts/python v2/tools/export_settings.py data/settings.json > settings-export.json
//   2. Import (v2/):        npm run import-settings -- ../settings-export.json
//
// Replaces users, site blocks and settings with the export's contents.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import {closeGazePool, getGazePool} from '../db/gaze-db.js';
import {runMigrations} from '../db/migrations.js';
import {importSettingsRecords, settingsToRecords} from '../lib/settings-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(__dirname, '..', '..', '..', '.env'), quiet: true});

async function main() {
    const file = process.argv[2];
    if (!file) throw new Error('Usage: npm run import-settings -- <settings-export.json>');
    const records = settingsToRecords(JSON.parse(fs.readFileSync(file, 'utf-8')));
    const pool = getGazePool();
    await runMigrations(pool);
    await importSettingsRecords(pool, records);
    console.log(`Imported ${records.users.length} users, ${records.siteBlocks.length} site blocks, ${Object.keys(records.settings).length} settings`);
    await closeGazePool();
}

main().catch(e => {
    console.error(e.message);
    process.exit(1);
});
