import {describe, expect, it} from 'vitest';
import {toCsv} from './csv';

describe('toCsv', () => {
    it('quotes only where needed', () => {
        expect(toCsv(['a', 'b'], [['plain', 'with, comma'], ['say "hi"', null]]))
            .toBe('a,b\r\nplain,"with, comma"\r\n"say ""hi""",');
    });
});
