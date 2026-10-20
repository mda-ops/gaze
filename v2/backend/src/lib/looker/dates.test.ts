import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {parseLookerDate} from './dates.js';

// Every date text in the Looker sources, read by the Python app
// (v2/tools/looker_reference.py; gitignored, skipped without it).

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, '..', '..', '..', '..', 'reference', 'looker', 'reference.json');

describe.skipIf(!fs.existsSync(FILE))('parseLookerDate matches the Python app', () => {
    it('reads every source date the same way', () => {
        const ref = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
        const mismatches = (ref.dates as [string | number | null, string | number | null, string | null][])
            .map(([raw, year, expected]) => [raw, year, parseLookerDate(raw, year ?? undefined, ref.today_year), expected])
            .filter(([, , ours, expected]) => ours !== (expected === 'NaT' ? null : expected));
        expect(JSON.stringify(mismatches)).toBe("[]");
    });
});
