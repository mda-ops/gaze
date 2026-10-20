import type {Column} from '../components/DataTable';
import {fmtMoney, fmtTableNumber, type MoneyContext} from './format';

// Columns formatted the way the Python app's table_html formats a DataFrame:
// by column name. "pct" columns are percentages, revenue/amount/commission/
// cost/salary/... columns are money, other numbers get up to two decimals,
// and some column names are renamed for display.

const RENAMES: Record<string, string> = {
    change_pct: '% Δ',
    change_amount: 'Δ Amount',
    previous_revenue: 'Previous Revenue',
    revenue_share_pct: 'Revenue Share %',
    revenue_per_hour: 'Revenue / Hour',
    messages_per_hour: 'Messages / Hour',
    average_revenue_per_day: 'Avg Revenue / Day',
    average_transaction_value: 'Avg Transaction',
    selected_revenue: 'Tips + Messages Revenue',
    tier_revenue: 'Tier Pace Revenue',
    line_item: 'Line Item',
    share_pct: 'Share %',
    source: 'Source',
    profit_loss_line: 'Profit / Loss Line',
    gross_rev: 'Gross Rev',
    net_rev: 'Net Rev',
    creator_share: 'Creator Share',
    partner_share: 'Partner Share',
    other_share: 'Other Share',
    chatter_commission: 'Chatter Commission',
    manager_commission: 'Manager Commission',
    platform_share: 'Platform Share',
};

const MONEY_KEYS = ['revenue', 'amount', 'payout', 'commission', 'money', 'cost', 'salary', 'gross_rev', 'net_rev', 'profit', 'loss'];

export type Cell = string | number | null;

export function formatCell(key: string, value: Cell, money: MoneyContext): string {
    if (value === null || value === '' || (typeof value === 'number' && Number.isNaN(value))) return '';
    const k = key.toLowerCase();
    if (typeof value === 'number') {
        if (k === 'change_pct' || k.includes('pct')) return `${fmtTableNumber(value)}%`;
        if (MONEY_KEYS.some(m => k.includes(m))) return fmtMoney(value, money);
        return fmtTableNumber(value);
    }
    return value;
}

// One column per [column name, value]; the name drives label and format.
export function pythonColumns<Row>(defs: [key: string, value: (row: Row) => Cell][], money: MoneyContext): Column<Row>[] {
    return defs.map(([key, value]) => ({
        label: RENAMES[key] ?? key,
        value: row => {
            const v = value(row);
            return v === '' ? null : v;
        },
        text: row => formatCell(key, value(row), money),
    }));
}
