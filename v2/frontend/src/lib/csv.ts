// Download a table as a CSV file (opens in Excel). Values are written as
// shown, quoted where needed.

function cell(value: unknown): string {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
    return [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, headers: string[], rows: unknown[][]): void {
    // BOM so Excel reads UTF-8 (names with accents, €).
    const blob = new Blob(['﻿', toCsv(headers, rows)], {type: 'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}
