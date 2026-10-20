// Number formatting exactly as the Python app's format() calls produce it.

// Python's format(x, ",.Nf"): rounds the exact binary value, exact ties to
// even (JavaScript's toLocaleString rounds the shortest decimal text instead,
// so 3215.995 gives 3,216.00 there but 3,215.99 in Python).
export function pyFixed(value: number, decimals: number, grouping = true): string {
    let text = value.toFixed(decimals);
    const exact = Math.abs(value).toFixed(100);
    const point = exact.indexOf('.');
    if (/^50*$/.test(exact.slice(point + 1 + decimals))) {
        const kept = exact.slice(0, decimals ? point + 1 + decimals : point);
        if (Number(kept.slice(-1)) % 2 === 0) text = (value < 0 ? '-' : '') + kept;
    }
    if (Object.is(value, -0) || (value < 0 && !text.startsWith('-'))) text = `-${text}`;
    if (!grouping) return text;
    const [whole, fraction] = text.split('.');
    const sign = whole.startsWith('-') ? '-' : '';
    const digits = whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + digits + (fraction !== undefined ? `.${fraction}` : '');
}

export const pyMoney = (value: number) => `€${pyFixed(value, 2)}`;

// Python fmt_compact: 73.7K, 1.3K, 37, -9.1K.
export function pyCompact(value: number, prefix = ''): string {
    const abs = Math.abs(value);
    let number: string;
    if (abs >= 1_000_000) number = `${pyFixed(value / 1_000_000, 1, false)}M`;
    else if (abs >= 1_000) number = `${pyFixed(value / 1_000, 1, false)}K`;
    else if (abs === Math.trunc(abs)) number = pyFixed(value, 0);
    else number = pyFixed(value, 1);
    return `${prefix}${number}`;
}

// Python fmt_pct: "+10.4%", "-29.9%", "n/a".
export function pyPct(value: number | null): string {
    if (value === null || Number.isNaN(value)) return 'n/a';
    return `${value > 0 ? '+' : ''}${pyFixed(value, 1, false)}%`;
}
