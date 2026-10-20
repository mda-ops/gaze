import {metricFor} from '../lib/metrics';

// A KPI card (Python app: kpi_card_html), with the metric's "i" tooltip.

function deltaClass(note: string): string {
    if (note.startsWith('% Δ +') || note.startsWith('+')) return 'delta-positive';
    if (note.startsWith('% Δ -') || note.startsWith('-')) return 'delta-negative';
    return '';
}

function valueClass(value: string): string {
    const match = value.replace('−', '-').match(/[-+]?\s*[€$£]?\s*\d[\d,]*(?:\.\d+)?/);
    if (!match) return '';
    const numeric = Number(match[0].replace(/[€$£,\s]/g, ''));
    return numeric > 0 ? 'kpi-positive' : numeric < 0 ? 'kpi-negative' : '';
}

export function KpiCard({label, value, note, metricKey}: {label: string; value: string; note: string; metricKey?: string}) {
    const metric = metricFor(label, metricKey);
    // Green/red only for real profit/loss metrics, as in the Python app.
    const colour = Boolean(metric?.profitLoss);
    const cardClass = ['kpi', colour ? valueClass(value) : ''].filter(Boolean).join(' ');
    const noteClass = colour ? deltaClass(note) : '';
    return (
        <div className={cardClass}>
            <span>
                {label}
                {metric && (
                    <span className="metric-tooltip-wrap">
                        <button type="button" className="metric-tooltip" aria-label={`About ${metric.label}`}
                                data-tooltip={metric.definition + (metric.formula ? ` Formula: ${metric.formula}.` : '')}>i</button>
                    </span>
                )}
            </span>
            <strong>{value}</strong>
            <em className={noteClass || undefined}>{note}</em>
        </div>
    );
}
