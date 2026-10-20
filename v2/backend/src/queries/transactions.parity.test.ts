import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import {afterAll, describe, expect, it} from 'vitest';
import {closeFlowPool, getFlowPool} from '../db/flow-db.js';
import {loadTransactions} from './transactions.js';

// Integration test against the real Flow database (read-only). Compares the
// new query with a frozen copy of the Python app's query, every row and every
// column. Skipped when no database is configured (v2/.env FLOW_DATABASE_URL).

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(here, '..', '..', '..', '.env'), quiet: true});
const LEGACY_SQL = fs.readFileSync(path.join(here, 'legacy', 'transactions.legacy.sql'), 'utf-8');

const RANGES: [string, string][] = [
    ['2026-09-01', '2026-10-14'], // typical page: month + comparison month
    ['2026-10-01', '2026-10-01'], // single day: midnight boundaries
    // All history up to a past day: ranges that include today change between
    // the two queries while Flow's miner keeps inserting transactions.
    ['2026-05-01', '2026-10-14'],
];

function byTransactionId(rows: Record<string, unknown>[]): Map<string, string> {
    return new Map(rows.map(row => [String(row.transaction_id), JSON.stringify(row)]));
}

describe.skipIf(!process.env.FLOW_DATABASE_URL)('transactions query parity with the Python app', () => {
    afterAll(closeFlowPool);

    it.each(RANGES)('%s to %s returns identical rows', async (start, end) => {
        const pool = getFlowPool();
        const legacy = (await pool.query(LEGACY_SQL, [start, end])).rows;
        const current = await loadTransactions(pool, start, end);

        expect(current.length).toBe(legacy.length);
        const legacyRows = byTransactionId(legacy);
        const currentRows = byTransactionId(current);
        const mismatched = [...legacyRows].filter(([id, row]) => currentRows.get(id) !== row);
        expect(mismatched.slice(0, 3)).toEqual([]);
    }, 120_000);
});
