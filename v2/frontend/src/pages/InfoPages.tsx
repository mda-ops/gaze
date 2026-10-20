import architecture from '../content/ARCHITECTURE.md?raw';
import {DataTable} from '../components/DataTable';
import {allMetrics, metricForLabel} from '../lib/metrics';
import {pythonColumns} from '../lib/pythonTable';

// Admin pages that only show fixed text (Python app: metric_definitions,
// inactivity_computation, architecture).

// Python: schema.METRIC_DEFINITIONS.
const OLDER_DEFINITIONS: [string, string][] = [
    ['Total Revenue', 'Sum of revenue for rows in the selected period. Missing revenue is excluded and flagged in Data Quality.'],
    ['Revenue Change %', '(current period revenue - comparison period revenue) / comparison period revenue * 100. If comparison is zero, change is shown as n/a.'],
    ['Revenue per Hour', 'Total revenue divided by total shift_hours where shift_hours is present and above zero.'],
    ['Active Chatters', 'Distinct non-empty chatters in the selected period.'],
    ['Active Creators', 'Distinct non-empty creators in the selected period.'],
    ['Total Hours', 'Sum of shift_hours in the selected period.'],
    ['Total Inactivity', 'Sum of inactive_minutes in the selected period.'],
    ['Average Revenue per Chatter', 'Total revenue divided by active chatters.'],
    ['Average Revenue per Creator', 'Total revenue divided by active creators.'],
    ['Revenue Share', 'Entity revenue divided by total selected-period revenue.'],
    ['Average Transaction Value', 'Total revenue divided by transaction count.'],
    ['Top-N Concentration', "Sum of the top N chatters' revenue divided by total selected-period revenue."],
    ['Messages per Hour', 'Messages sent divided by shift_hours.'],
    ['Commission Payout', 'Gross revenue multiplied by configured commission percentage for the matching rule.'],
];

export function MetricDefinitionsPage() {
    return (
        <section className="panel">
            <h2>Metric Definitions</h2>
            {allMetrics().map(m => (
                <p key={m.label}><strong>{m.label}:</strong> {m.definition}{m.formula && <> <em>{m.formula}</em></>}</p>
            ))}
            {/* The older definitions, unless the registry already covers the label. */}
            {OLDER_DEFINITIONS.filter(([label]) => metricForLabel(label) === null).map(([label, text]) => (
                <p key={label}><strong>{label}:</strong> {text}</p>
            ))}
        </section>
    );
}

type Row = Record<string, string>;

const tierRow = (tier: string): Row => ({
    'Tier': tier,
    'Source': 'RevenueCatcher creator tier badge',
    'Revenue / hour': `${tier} weighted avg model tips + messages per scheduled hour, by CET sales interval`,
    'Inactivity %': `${tier} scheduled inactive hours in that interval / ${tier} scheduled shift hours in that interval`,
    'Money wasted': `Sum of each interval: ${tier} shift hours in interval x ${tier} inactivity % in interval x ${tier} revenue/hour in interval`,
});

const EXAMPLE_ROWS: Row[] = [
    {'Tier': 'Tier A', 'Time': 'Quiet hour', 'Shift hours': '50.0h', 'Scheduled inactive hours': '4.0h', 'Inactivity %': '8.0%', 'Revenue / hour': '€60.00', 'Money wasted': '€240.00'},
    {'Tier': 'Tier A', 'Time': 'Peak hour', 'Shift hours': '50.0h', 'Scheduled inactive hours': '4.0h', 'Inactivity %': '8.0%', 'Revenue / hour': '€180.00', 'Money wasted': '€720.00'},
    {'Tier': 'Tier A', 'Time': 'Total', 'Shift hours': '100.0h', 'Scheduled inactive hours': '8.0h', 'Inactivity %': '8.0%', 'Revenue / hour': 'blended', 'Money wasted': '€960.00'},
];

function TextTable({rows}: {rows: Row[]}) {
    const columns = pythonColumns<Row>(Object.keys(rows[0]).map(key => [key, r => r[key]]), {currency: 'EUR', eurUsdRate: 1});
    return <DataTable rows={rows} columns={columns}/>;
}

export function InactivityComputationPage() {
    return (
        <>
            <section className="panel">
                <h2>Inactivity Computation</h2>
                <p className="note">This page documents how GAZE estimates money wasted from inactivity. The live Inactivity page uses RevenueCatcher inactivity episodes, RevenueCatcher scheduled shifts, model revenue, and RevenueCatcher creator tiers.</p>
            </section>
            <section className="panel">
                <h2>Main Formula</h2>
                <p className="answer">Money wasted = sum of each CET sales interval: shift hours in that interval x inactivity percentage in that interval x model revenue per hour in that interval.</p>
                <p className="note">This means inactivity during peak or mid-peak sales intervals costs more than inactivity during average or slow intervals. The same formula can also be read as scheduled inactive hours in each interval x model revenue/hour for that same interval.</p>
            </section>
            <section className="panel">
                <h2>Inputs</h2>
                <p><strong>Shift hours:</strong> total scheduled RevenueCatcher shift hours for the selected period.</p>
                <p><strong>Scheduled inactive hours:</strong> only the inactivity minutes that overlap an actual scheduled shift. If an inactivity event is longer than the shift overlap, GAZE counts only the overlapped time.</p>
                <p><strong>Inactivity percentage:</strong> scheduled inactive hours divided by scheduled shift hours for the same CET sales interval.</p>
                <p><strong>Model revenue per hour:</strong> selected-period model tips + messages revenue divided by scheduled shift hours for the same CET sales interval. Subscriptions are not included.</p>
                <p><strong>Sales interval:</strong> hourly CET/RevenueCatcher-local buckets that naturally separate peak, mid-peak, average, and slow periods based on actual revenue pace.</p>
                <p><strong>Creator tier:</strong> the official RevenueCatcher creator tier badge. Tier is used for the per-tier rollup and as fallback/cap context when a model has too little revenue history in the selected period.</p>
            </section>
            <section className="panel"><h2>Per-Tier Computation</h2><TextTable rows={['Tier A', 'Tier B', 'Tier C'].map(tierRow)}/></section>
            <section className="panel"><h2>Simple Example</h2><TextTable rows={EXAMPLE_ROWS}/></section>
            <section className="panel">
                <h2>Accuracy Rules</h2>
                <p><strong>Schedule based:</strong> unscheduled inactivity is excluded from money wasted.</p>
                <p><strong>Revenue based:</strong> the estimate follows what the model actually made from tips + messages during the selected period.</p>
                <p><strong>Time-interval aware:</strong> the estimate is calculated hour by hour in CET, so peak sales windows count more than average or slow windows.</p>
                <p><strong>Tier aware:</strong> Tier A, B, and C are calculated separately so higher-revenue tiers carry the correct earning pace for each sales interval without letting one extreme row inflate everyone.</p>
                <p><strong>Capped:</strong> when a model has sparse revenue data, GAZE uses tier-level rates as a fallback/cap so the estimate stays realistic.</p>
            </section>
        </>
    );
}

// The Python app shows its ARCHITECTURE.md; v2 bundles a copy of it.
export function ArchitecturePage() {
    return <section className="panel markdown"><pre>{architecture}</pre></section>;
}
