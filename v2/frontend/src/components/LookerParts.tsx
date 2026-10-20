import {fmtCompact, fmtMoney, pyFixed} from '../lib/format';
import {pythonColumns, type Cell} from '../lib/pythonTable';
import {TICKET_STATUS_COLORS, ticketStatusGradient} from '../lib/ticketColors';
import {ColumnChart, HorizontalChart} from './CHubCharts';
import {DataTable} from './DataTable';

// Pieces of the Hub and C Hub Looker pages (Python app: c_line_chart,
// ticket_department_chart, ticket_status_donut, source_note, table_html).

export type TableValue = string | number | boolean | null;
export interface Table {
    columns: string[];
    rows: TableValue[][];
}

export interface Chart {
    rows: {label: string; value: number}[];
    format: 'money' | 'compact' | 'score';
    limit: number;
}

const EUR = {currency: 'EUR' as const, eurUsdRate: 1};
const FORMATS: Record<Chart['format'], (v: number) => string> = {
    money: v => fmtMoney(v, EUR),
    compact: v => fmtCompact(v),
    score: v => `${pyFixed(v, 0)}/100`,
};

export function Bars({chart, href, kind}: {chart: Chart; href: string; kind: 'horizontal' | 'column'}) {
    const Component = kind === 'horizontal' ? HorizontalChart : ColumnChart;
    return <Component rows={chart.rows} href={href} format={FORMATS[chart.format]} limit={chart.limit}/>;
}

// Python: table_html of a DataFrame.
export function TableView({table}: {table: Table}) {
    if (!table.rows.length) return <div className="empty">No rows for the selected filters.</div>;
    const columns = pythonColumns<TableValue[]>(table.columns.map((name, i): [string, (row: TableValue[]) => Cell] => [name, row => {
        const v = row[i];
        return typeof v === 'boolean' ? (v ? 'True' : 'False') : v;
    }]), EUR);
    return <DataTable rows={table.rows} columns={columns}/>;
}

export interface SourceNoteData {
    title: string;
    url: string;
    tabs: string;
    extra: string;
}

export function SourceNote({source}: {source: SourceNoteData}) {
    return (
        <section className="notice"><strong>Source:</strong> <a href={source.url}>{source.title}</a> · tabs: {source.tabs}{source.extra}</section>
    );
}

// Python's round(): halves to even.
function pyRound(x: number): number {
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
}

// Python's "{:g}".
function pyG(value: number): string {
    if (value === 0) return '0';
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
    const exp = Math.floor(Math.log10(Math.abs(Number(value.toPrecision(6)))));
    if (exp < -4 || exp >= 6) {
        const [mantissa, e] = value.toExponential(5).split('e');
        const m = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
        const n = Number(e);
        return `${m}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
    }
    const fixed = value.toFixed(Math.max(0, 5 - exp));
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Python: compact_axis_label. "1  Apr 26" -> "Apr 1"; other text is shortened.
function axisLabel(label: string): string {
    const tokens = label.trim().split(/[\s,./-]+/).filter(Boolean);
    const monthAt = tokens.findIndex(t => MONTHS.includes(t.slice(0, 3).toLowerCase()) && /^[a-z]+$/i.test(t));
    const numbers = tokens.filter(t => /^\d+$/.test(t));
    if (monthAt >= 0 && numbers.length && tokens.length === numbers.length + 1) {
        const day = Number(numbers[0]);
        if (day >= 1 && day <= 31) return `${SHORT[MONTHS.indexOf(tokens[monthAt].slice(0, 3).toLowerCase())]} ${day}`;
    }
    const iso = label.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${SHORT[Number(iso[2]) - 1]} ${Number(iso[3])}`;
    return label.length > 15 ? `${label.slice(0, 12)}...` : label;
}

export function LineChart({points, href}: {points: {label: string; value: number}[]; href: string}) {
    if (!points.length) return <div className="empty">No line chart data for this range.</div>;
    const width = 620;
    const height = 220;
    const padX = 42;
    const padY = 28;
    const maxValue = Math.max(Math.max(...points.map(p => p.value)), 1);
    const step = (width - padX * 2) / Math.max(points.length - 1, 1);
    const maxTicks = Math.min(6, points.length);
    const ticks = new Set(Array.from({length: maxTicks}, (_, i) => pyRound(i * (points.length - 1) / Math.max(maxTicks - 1, 1))));
    const at = points.map((p, i) => ({...p, x: padX + step * i, y: height - padY - (p.value / maxValue * (height - padY * 2))}));
    return (
        <a className="c-line-chart" href={href}>
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Line chart">
                <defs>
                    <linearGradient id="gaze-line-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#f2d36b"/><stop offset="72%" stopColor="#c89b3c"/><stop offset="100%" stopColor="#080705"/>
                    </linearGradient>
                </defs>
                <g className="c-line-grid">
                    {[0, 1, 2, 3, 4].map(i => <line key={i} x1={padX} x2={width - padX} y1={padY + i * 38} y2={padY + i * 38}/>)}
                </g>
                <polyline points={at.map(p => `${pyFixed(p.x, 1)},${pyFixed(p.y, 1)}`).join(' ')}/>
                <g className="c-line-dots">
                    {at.map((p, i) => (
                        <circle key={i} cx={pyFixed(p.x, 1)} cy={pyFixed(p.y, 1)} r="4"><title>{p.label}: {pyG(p.value)}</title></circle>
                    ))}
                </g>
                <g className="c-line-labels">
                    {at.map((p, i) => ticks.has(i) && (
                        <text key={i} x={pyFixed(p.x, 1)} y={height - 7} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>
                            {axisLabel(p.label)}
                        </text>
                    ))}
                </g>
            </svg>
        </a>
    );
}

// Python: ticket_department_chart, from rows of [Department, Status, tickets].
export function TicketDepartmentChart({table}: {table: Table}) {
    if (!table.rows.length) return <div className="empty">No department rows for the selected dates.</div>;
    const rows = table.rows.map(r => ({department: String(r[0]), status: String(r[1]), tickets: Number(r[2])}));
    const departments = [...new Set(rows.map(r => r.department))];
    const present = new Set(rows.map(r => r.status));
    const statuses = Object.keys(TICKET_STATUS_COLORS).filter(s => present.has(s));
    const totals = departments.map(d => rows.filter(r => r.department === d).reduce((s, r) => s + r.tickets, 0));
    const maxTotal = Math.max(1, ...totals);
    return (
        <>
            <div className="ticket-legend">
                {statuses.map(s => <span key={s}><i style={{background: ticketStatusGradient(s)}}/>{s}</span>)}
            </div>
            <div className="stacked-chart">
                {departments.map((department, i) => (
                    <div key={department} className="stack-bar-wrap">
                        <div className="stack-bar">
                            {statuses.map(status => {
                                const count = rows.filter(r => r.department === department && r.status === status).reduce((s, r) => s + r.tickets, 0);
                                if (!count) return null;
                                const dark = ['Completed', 'In progress', 'Declined'].includes(status);
                                return (
                                    <span key={status} className="stack-segment" title={`${status}: ${count}`}
                                          style={{height: `${pyFixed(Math.max(8, count / maxTotal * 150), 1)}px`, background: ticketStatusGradient(status), color: dark ? '#100d08' : '#fff4cf'}}>
                                        {count}
                                    </span>
                                );
                            })}
                        </div>
                        <span className="stack-label">{department}</span>
                        <small>{totals[i]}</small>
                    </div>
                ))}
            </div>
        </>
    );
}

// Python: ticket_status_donut, from rows of [status, tickets].
export function TicketStatusDonut({table}: {table: Table}) {
    if (!table.rows.length) return <div className="empty">No status rows for the selected dates.</div>;
    const rows = table.rows.map(r => ({status: String(r[0]), tickets: Number(r[1])}));
    const total = Math.max(1, rows.reduce((s, r) => s + r.tickets, 0));
    let angle = 0;
    const parts = rows.map(r => {
        const next = angle + r.tickets / total * 360;
        const part = `${TICKET_STATUS_COLORS[r.status] ?? '#9b8b62'} ${pyFixed(angle, 1)}deg ${pyFixed(next, 1)}deg`;
        angle = next;
        return part;
    });
    return (
        <div className="donut-layout">
            <div className="donut-chart" style={{background: `conic-gradient(${parts.join(', ')})`}}><span>{total}</span></div>
            <div className="ticket-legend vertical">
                {rows.map(r => <span key={r.status}><i style={{background: ticketStatusGradient(r.status)}}/>{r.status} <strong>{r.tickets}</strong></span>)}
            </div>
        </div>
    );
}
