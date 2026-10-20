import {fmtCompact, pyFixed} from '../lib/format';
import {TICKET_STATUS_COLORS, ticketStatusGradient} from '../lib/ticketColors';

// The C Hub chart widgets of the Python app (c_strength_requirement_chart,
// c_donut_chart, c_horizontal_chart, c_column_chart), same markup and classes.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "%b %d": "Sep 05"
const monthDay = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(8, 10)}`;

function Empty({text = 'No chart data for this date range.'}: {text?: string}) {
    return <div className="empty">{text}</div>;
}

export function StrengthRequirementChart({weeks}: {weeks: {week: string; start: string; end: string; teamStrength: number; modelRequirement: number; gap: number}[]}) {
    if (!weeks.length) return <Empty text="No weekly strength rows yet."/>;
    const max = Math.max(1, ...weeks.flatMap(w => [w.teamStrength, w.modelRequirement]));
    return (
        <>
            <div className="strength-legend">
                <span><i className="legend-strength"/>Team strength</span>
                <span><i className="legend-requirement"/>Model requirement</span>
            </div>
            <div className="strength-chart">
                {weeks.map(w => {
                    const strengthHeight = w.teamStrength > 0 ? Math.max(5, w.teamStrength / max * 100) : 0;
                    const requirementHeight = w.modelRequirement > 0 ? Math.max(5, w.modelRequirement / max * 100) : 0;
                    return (
                        <div key={w.week} className="strength-week">
                            <div className="strength-bars" title={`${w.week}: strength ${fmtCompact(w.teamStrength)}, requirement ${fmtCompact(w.modelRequirement)}`}>
                                {w.modelRequirement > 0 && (
                                    <i className="requirement-shadow" style={{height: `${pyFixed(requirementHeight, 1)}%`}}><em>{fmtCompact(w.modelRequirement)}</em></i>
                                )}
                                <i className="strength-main" style={{height: `${pyFixed(strengthHeight, 1)}%`}}><strong>{fmtCompact(w.teamStrength)}</strong></i>
                            </div>
                            <span>{w.week}</span>
                            <small>{monthDay(w.start)} - {monthDay(w.end)}</small>
                            <b className={w.gap >= 0 ? 'delta-positive' : 'delta-negative'}>{fmtCompact(w.gap, w.gap >= 0 ? '+' : '')}</b>
                        </div>
                    );
                })}
            </div>
        </>
    );
}

const PALETTE = ['#f4d46f', '#d2a746', '#b2853a', '#8e662a', '#6f5023', '#4d371a'];

export function DonutChart({rows, href}: {rows: {label: string; value: number}[]; href: string}) {
    if (!rows.length) return <Empty/>;
    const total = Math.max(1, rows.reduce((s, r) => s + (r.value || 0), 0));
    let angle = 0;
    const gradients: string[] = [];
    const legend: {label: string; swatch: string; pct: number}[] = [];
    rows.forEach((row, index) => {
        if (row.value <= 0) return;
        // Ticket statuses keep their own colours (Python: TICKET_STATUS_COLORS).
        const color = TICKET_STATUS_COLORS[row.label] ?? PALETTE[index % PALETTE.length];
        const next = angle + row.value / total * 360;
        gradients.push(`${color} ${pyFixed(angle, 1)}deg ${pyFixed(next, 1)}deg`);
        const swatch = row.label in TICKET_STATUS_COLORS ? ticketStatusGradient(row.label) : `linear-gradient(180deg, #fff0a9, ${color} 58%, #3a2814)`;
        legend.push({label: row.label, swatch, pct: row.value / total * 100});
        angle = next;
    });
    if (!gradients.length) return <Empty/>;
    return (
        <div className="c-donut-wrap">
            <a className="c-donut" href={href} title="Click to open details" style={{background: `conic-gradient(${gradients.join(', ')})`}}><span>{fmtCompact(total)}</span></a>
            <div className="c-donut-legend">
                {legend.map(l => (
                    <a key={l.label} href={href}>
                        <i style={{background: l.swatch}}/>
                        <span>{l.label}</span>
                        <strong>{pyFixed(l.pct, 1)}%</strong>
                    </a>
                ))}
            </div>
        </div>
    );
}

export function HorizontalChart({rows, href, format = v => fmtCompact(v), limit = 6}: {
    rows: {label: string; value: number}[]; href: string; format?: (value: number) => string; limit?: number;
}) {
    if (!rows.length) return <Empty/>;
    const shown = [...rows].sort((a, b) => b.value - a.value).slice(0, limit);
    const max = Math.max(1, ...shown.map(r => r.value));
    return (
        <div className="c-horizontal-chart">
            {shown.map((r, i) => (
                <a key={`${r.label}-${i}`} className="c-bar-row" href={href} title={`${r.label}: ${format(r.value)}`}>
                    <span>{r.label}</span>
                    <i><b style={{width: `${pyFixed(Math.max(4, r.value / max * 100), 1)}%`}}/></i>
                    <strong>{format(r.value)}</strong>
                </a>
            ))}
        </div>
    );
}

export function ColumnChart({rows, href, format = v => fmtCompact(v), limit = 7}: {
    rows: {label: string; value: number}[]; href: string; format?: (value: number) => string; limit?: number;
}) {
    if (!rows.length) return <Empty/>;
    const shown = [...rows].sort((a, b) => b.value - a.value).slice(0, limit);
    const max = Math.max(1, ...shown.map(r => r.value));
    return (
        <div className="c-column-chart">
            {shown.map((r, i) => (
                <a key={`${r.label}-${i}`} className="c-column" href={href} title={`${r.label}: ${format(r.value)}`}>
                    <i style={{height: `${pyFixed(Math.max(9, r.value / max * 100), 1)}%`}}/>
                    <strong>{format(r.value)}</strong>
                    <span>{r.label}</span>
                </a>
            ))}
        </div>
    );
}

export function StatStrip({tiles}: {tiles: [label: string, value: string, note: string][]}) {
    return (
        <section className="c-stat-strip">
            {tiles.map(([label, value, note]) => (
                <div key={label} className="c-stat-tile"><span>{label}</span><strong>{value}</strong><em>{note}</em></div>
            ))}
        </section>
    );
}
