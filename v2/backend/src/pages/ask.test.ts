import {describe, expect, it} from 'vitest';
import {askAnswer} from './ask.js';
import type {GroupRow} from './core-analysis.js';

const row = (key: string, hours: number, revenuePerHour: number | null, changeAmount = 0) =>
    ({key, hours, revenue_per_hour: revenuePerHour, change_amount: changeAmount}) as GroupRow;

describe('askAnswer', () => {
    const rows = [row('A', 10, 50, -5), row('B', 40, 20, 30), row('C', 40, 10), row('D', 0, null, 3)];

    it('picks the most improved chatter', () => {
        expect(askAnswer('Who improved the most?', rows)).toEqual({kind: 'improved', chatter: 'B', changeAmount: 30});
    });

    it('picks the most hours, then the lowest revenue per hour', () => {
        expect(askAnswer('Who has high hours but low revenue?', rows)).toMatchObject({kind: 'highHours', chatter: 'C'});
    });

    it('picks the highest revenue per hour, missing values last', () => {
        expect(askAnswer('Who has the highest revenue per hour?', rows)).toMatchObject({kind: 'bestRate', chatter: 'A', revenuePerHour: 50});
    });

    it('has no answer for other questions or no data', () => {
        expect(askAnswer('Something else', rows)).toEqual({kind: 'none'});
        expect(askAnswer('Who improved the most?', [])).toEqual({kind: 'none'});
    });
});
