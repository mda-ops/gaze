import {describe, expect, it} from 'vitest';
import {cleanNumber, readCsv} from './frame.js';

describe('readCsv', () => {
    it('reads like pandas: names, missing values and column types', () => {
        const frame = readCsv('Date,,Score,Score,Text,Mixed\r\n1 Apr,x,1,1.5,"a,""b""\r\nc",-\r\n\r\n2 Apr,,2,,None,3\n');
        expect(frame.columns).toEqual(['Date', 'Unnamed: 1', 'Score', 'Score.1', 'Text', 'Mixed']);
        expect(frame.types).toEqual({'Date': 'str', 'Unnamed: 1': 'str', 'Score': 'int', 'Score.1': 'float', 'Text': 'str', 'Mixed': 'str'});
        expect(frame.rows).toEqual([
            {'Date': '1 Apr', 'Unnamed: 1': 'x', 'Score': 1, 'Score.1': 1.5, 'Text': 'a,"b"\r\nc', 'Mixed': '-'},
            {'Date': '2 Apr', 'Unnamed: 1': null, 'Score': 2, 'Score.1': null, 'Text': null, 'Mixed': '3'},
        ]);
    });
});

describe('cleanNumber', () => {
    it('reads money and percent text, anything else is 0', () => {
        expect(cleanNumber('$1,234.50')).toBe(1234.5);
        expect(cleanNumber('12%')).toBe(12);
        expect(cleanNumber('EUR 5')).toBe(5);
        expect(cleanNumber('€5')).toBe(0);
        expect(cleanNumber('warmup')).toBe(0);
        expect(cleanNumber(null)).toBe(0);
        expect(cleanNumber(7)).toBe(7);
    });
});
