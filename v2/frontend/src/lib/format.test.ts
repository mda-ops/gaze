import {describe, expect, it} from 'vitest';
import {fmtMoney, fmtNum, fmtPct, fmtSignedMoney, fmtTableNumber, periodLabel, shortDateLabel} from './format';

const EUR = {currency: 'EUR' as const, eurUsdRate: 1.12};

describe('format (same output as the Python app)', () => {
    it('formats money', () => {
        expect(fmtMoney(710662.6132, EUR)).toBe('€710,662.61');
        expect(fmtMoney(100, {currency: 'USD', eurUsdRate: 1.12})).toBe('$112.00');
        expect(fmtMoney(null, EUR)).toBe('n/a');
        expect(fmtSignedMoney(-1234.5)).toBe('-€1,234.50');
        expect(fmtSignedMoney(0)).toBe('€0.00');
    });

    it('formats numbers and percentages', () => {
        expect(fmtNum(15187.94)).toBe('15,187.9');
        expect(fmtPct(10.44)).toBe('+10.4%');
        expect(fmtPct(-29.96)).toBe('-30.0%');
        expect(fmtPct(null)).toBe('n/a');
        expect(fmtTableNumber(4859)).toBe('4,859');
        expect(fmtTableNumber(30.5)).toBe('30.5');
        expect(fmtTableNumber(1.006)).toBe('1.01');
    });

    it('rounds like Python: exact binary value, ties to even', () => {
        expect(fmtMoney(3215.995, EUR)).toBe('€3,215.99');
        expect(fmtMoney(1.125, EUR)).toBe('€1.12');
        expect(fmtMoney(1.375, EUR)).toBe('€1.38');
        expect(fmtMoney(-0, EUR)).toBe('€-0.00');
        expect(fmtNum(0.25)).toBe('0.2');
    });

    it('formats dates', () => {
        expect(periodLabel('2026-09-01', '2026-09-30')).toBe('01 Sep 2026 - 30 Sep 2026');
        expect(periodLabel('2026-10-01', '2026-10-01')).toBe('01 Oct 2026');
        expect(shortDateLabel('2026-10-14')).toBe('14 Oct');
    });
});
