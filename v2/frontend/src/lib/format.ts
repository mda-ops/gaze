// Number formatting, matching the Python app's fmt_* helpers exactly.

export type Currency = 'EUR' | 'USD';

// Amounts are EUR; in USD display they are multiplied by Flow's EUR/USD rate.
export interface MoneyContext {
    currency: Currency;
    eurUsdRate: number;
}

// Python's format(x, ",.Nf"): rounds the exact binary value, exact ties to
// even. (toLocaleString rounds the shortest decimal text instead: 3215.995 is
// stored as 3215.99499..., Python shows 3,215.99 and toLocaleString 3,216.00.)
export function pyFixed(value: number, decimals: number): string {
    let text = value.toFixed(decimals);
    const exact = Math.abs(value).toFixed(100);
    const point = exact.indexOf('.');
    if (/^50*$/.test(exact.slice(point + 1 + decimals))) {
        const kept = exact.slice(0, decimals ? point + 1 + decimals : point);
        if (Number(kept.slice(-1)) % 2 === 0) text = (value < 0 ? '-' : '') + kept;
    }
    if (Object.is(value, -0) || (value < 0 && !text.startsWith('-'))) text = `-${text}`;
    return text;
}

// Grouped with commas, Python rounding ("{:,.Nf}").
export function grouped(value: number, decimals: number): string {
    const [whole, fraction] = pyFixed(value, decimals).split('.');
    const sign = whole.startsWith('-') ? '-' : '';
    const digits = whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + digits + (fraction !== undefined ? `.${fraction}` : '');
}

// fmt_money: "€1,234.56" / "$1,382.30"; null -> "n/a"
export function fmtMoney(value: number | null | undefined, money: MoneyContext): string {
    if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
    return money.currency === 'USD' ? `$${grouped(value * money.eurUsdRate, 2)}` : `€${grouped(value, 2)}`;
}

// fmt_signed_money: always EUR in the Python app.
export function fmtSignedMoney(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
    const sign = value > 0 ? '+' : value < 0 ? '-' : '';
    return `${sign}€${grouped(Math.abs(value), 2)}`;
}

// fmt_num: one decimal, grouped
export function fmtNum(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
    return grouped(value, 1);
}

// fmt_pct: "+10.4%", "-29.9%", "n/a"
export function fmtPct(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
    return `${value > 0 ? '+' : ''}${pyFixed(value, 1)}%`;
}

// fmt_table_number: up to two decimals, trailing zeros removed
export function fmtTableNumber(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    const text = grouped(value, 2);
    return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// period_label: "01 Sep 2026" or "01 Sep 2026 - 30 Sep 2026"
export function periodLabel(start: string, end: string): string {
    const one = (d: string) => `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
    return start === end ? one(start) : `${one(start)} - ${one(end)}`;
}

// app.js shortDateLabel: "14 Oct"
export function shortDateLabel(date: string): string {
    return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

// app.js money(): whole euros, for chart labels
export function chartMoney(value: number): string {
    return `€${Math.round(value || 0).toLocaleString('en-US')}`;
}

// fmt_int: whole number, truncated, grouped ("2,143")
export function fmtInt(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '0';
    return Math.trunc(value).toLocaleString('en-US');
}

// platform_color_class
export function platformColorClass(platform: string): string {
    const label = platform.toLowerCase();
    if (label === 'f2f') return 'platform-f2f';
    if (label === 'knky') return 'platform-knky';
    if (label === 'of') return 'platform-of';
    return 'platform-other';
}

// fmt_compact: 73.7K, 1.3M, 37, 12.5 (Python rounding)
export function fmtCompact(value: number | null | undefined, prefix = ''): string {
    const v = Number(value || 0);
    const abs = Math.abs(v);
    let number: string;
    if (abs >= 1_000_000) number = `${pyFixed(v / 1_000_000, 1)}M`;
    else if (abs >= 1_000) number = `${pyFixed(v / 1_000, 1)}K`;
    else if (abs === Math.trunc(abs)) number = grouped(v, 0);
    else number = grouped(v, 1);
    return `${prefix}${number}`;
}
