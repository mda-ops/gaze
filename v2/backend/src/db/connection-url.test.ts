import {describe, expect, it} from 'vitest';
import {withoutSslParams} from './connection-url.js';

describe('withoutSslParams', () => {
    it('drops ssl parameters and keeps the rest', () => {
        expect(withoutSslParams('postgresql://u:p@h.proxy.rlwy.net:1/db?sslmode=require')).toBe('postgresql://u:p@h.proxy.rlwy.net:1/db');
        expect(withoutSslParams('postgresql://u:p@h:1/db?sslmode=require&application_name=gaze')).toBe('postgresql://u:p@h:1/db?application_name=gaze');
        expect(withoutSslParams('postgresql://u:p@h:1/db')).toBe('postgresql://u:p@h:1/db');
    });
});
