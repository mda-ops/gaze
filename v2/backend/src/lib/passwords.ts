import crypto from 'node:crypto';

// Password hashes, compatible with the Python app so imported users keep
// their passwords.
//
//   pbkdf2_sha256$<salt>$<hex digest>               Python app format, 120,000 iterations
//   pbkdf2_sha256$<iterations>$<salt>$<hex digest>  v2 format for new passwords
//
// The salt is used as its text (UTF-8 bytes), as the Python app does.

const PREFIX = 'pbkdf2_sha256';
const LEGACY_ITERATIONS = 120_000;
// OWASP's current recommendation for PBKDF2-HMAC-SHA256.
const ITERATIONS = 600_000;

function digest(password: string, salt: string, iterations: number): Buffer {
    return crypto.pbkdf2Sync(Buffer.from(password, 'utf-8'), Buffer.from(salt, 'utf-8'), iterations, 32, 'sha256');
}

export function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    return `${PREFIX}$${ITERATIONS}$${salt}$${digest(password, salt, ITERATIONS).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
    if (!stored || !stored.startsWith(`${PREFIX}$`)) return false;
    const parts = stored.split('$');
    let iterations: number;
    let salt: string;
    let expectedHex: string;
    if (parts.length === 3) {
        [, salt, expectedHex] = parts;
        iterations = LEGACY_ITERATIONS;
    } else if (parts.length === 4 && /^\d+$/.test(parts[1])) {
        iterations = Number(parts[1]);
        [, , salt, expectedHex] = parts;
    } else {
        return false;
    }
    const expected = Buffer.from(expectedHex, 'hex');
    if (expected.length !== 32) return false;
    return crypto.timingSafeEqual(digest(password, salt, iterations), expected);
}
