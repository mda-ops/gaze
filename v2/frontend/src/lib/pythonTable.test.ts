import {describe, expect, it} from 'vitest';
import {formatCell} from './pythonTable';

const EUR = {currency: 'EUR' as const, eurUsdRate: 1.12};

describe('formatCell (Python table_html rules)', () => {
    it('formats by column name', () => {
        expect(formatCell('manager_cut_pct', 1.5000000000000002, EUR)).toBe('1.5%');
        expect(formatCell('attributed_revenue', 42517.81, EUR)).toBe('€42,517.81');
        expect(formatCell('base_commission', 10174.4286, EUR)).toBe('€10,174.43');
        expect(formatCell('flow_bonus', 738.50385, EUR)).toBe('738.5');
        expect(formatCell('commission_pct', 8, EUR)).toBe('8%');
        expect(formatCell('transactions', 22273, EUR)).toBe('22,273');
    });

    it('leaves text and blanks alone', () => {
        expect(formatCell('commission_plan', 'Flow rate 10% · Premium', EUR)).toBe('Flow rate 10% · Premium');
        expect(formatCell('amount', null, EUR)).toBe('');
    });
});
