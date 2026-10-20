import {describe, expect, it} from 'vitest';
import {flowPoolConfig} from './flow-db.js';

describe('flowPoolConfig', () => {
    it('forces every session to be read-only', () => {
        const config = flowPoolConfig('postgresql://user:pass@host:5432/db');
        expect(config.options).toContain('default_transaction_read_only=on');
    });
});
