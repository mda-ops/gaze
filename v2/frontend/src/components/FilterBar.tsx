import {useEffect, useState, type FormEvent} from 'react';
import {useConfig} from '../api/config';
import {COMPARE_LABELS, DATE_RANGE_LABELS, dateRangeFor} from '../lib/dateRanges';
import {fmtMoney, fmtPct, fmtSignedMoney, periodLabel, type MoneyContext} from '../lib/format';
import {FILTER_FIELDS, type FilterField, type PageQuery} from '../lib/pageQuery';
import {LuxSelect} from './LuxSelect';

// The filter form at the top of analysis pages (Python app: filter_bar).
// Changes apply on "Apply", like the original GET form.

const FIELD_LABELS: Record<FilterField, string> = {
    platform: 'Platform', team: 'Team', creator: 'Creator', chatter: 'Chatter', transaction_type: 'Transaction Type',
};

export function FilterBar({query, options, onApply, includeTransactionType = true}: {
    query: PageQuery;
    options: Record<FilterField, string[]>;
    onApply: (next: PageQuery) => void;
    // The Inactivity page has no transaction type filter.
    includeTransactionType?: boolean;
}) {
    const config = useConfig();
    const [draft, setDraft] = useState(query);
    useEffect(() => setDraft(query), [query]);

    function setRange(range: string) {
        if (range === 'Custom' || !config.data) {
            setDraft(d => ({...d, range}));
            return;
        }
        const [start, end] = dateRangeFor(range, config.data.today, config.data.reportingWeekStart);
        setDraft(d => ({...d, range, start, end}));
    }

    function submit(event: FormEvent) {
        event.preventDefault();
        onApply(draft);
    }

    return (
        <form className="filters" onSubmit={submit}>
            <label>Date Range
                <LuxSelect options={DATE_RANGE_LABELS.map(l => ({value: l, label: l}))} value={draft.range} onChange={setRange}/>
            </label>
            <label>Start<input type="date" name="start" value={draft.start} onChange={e => setDraft(d => ({...d, start: e.target.value, range: 'Custom'}))}/></label>
            <label>End<input type="date" name="end" value={draft.end} onChange={e => setDraft(d => ({...d, end: e.target.value, range: 'Custom'}))}/></label>
            <label>Compare
                <LuxSelect options={COMPARE_LABELS.map(l => ({value: l, label: l}))} value={draft.compare} onChange={compare => setDraft(d => ({...d, compare}))}/>
            </label>
            <label>Display Currency
                <LuxSelect options={[{value: 'EUR', label: 'EUR'}, {value: 'USD', label: 'USD'}]} value={draft.currency}
                           onChange={currency => setDraft(d => ({...d, currency: currency === 'USD' ? 'USD' : 'EUR'}))}/>
            </label>
            {FILTER_FIELDS.filter(field => includeTransactionType || field !== 'transaction_type').map(field => (
                <label key={field}>{FIELD_LABELS[field]}
                    <LuxSelect multiple options={options[field].map(v => ({value: v, label: v}))} value={draft.filters[field]}
                               onChange={values => setDraft(d => ({...d, filters: {...d.filters, [field]: values}}))}/>
                </label>
            ))}
            <button type="submit">Apply</button>
        </form>
    );
}

// The strip under the filters (Python app: comparison_context_html).
export function ComparisonContext({query, compareStart, compareEnd, currentRevenue, previousRevenue, money}: {
    query: PageQuery;
    compareStart: string;
    compareEnd: string;
    currentRevenue: number | null;
    previousRevenue: number | null;
    money: MoneyContext;
}) {
    const hasTotals = currentRevenue !== null && previousRevenue !== null;
    const delta = hasTotals ? currentRevenue - previousRevenue : 0;
    const deltaPct = hasTotals && previousRevenue ? delta / previousRevenue * 100 : null;
    const deltaClass = delta > 0 ? 'comparison-context__delta--positive' : delta < 0 ? 'comparison-context__delta--negative' : 'comparison-context__delta--neutral';
    return (
        <div className="comparison-context">
            <span className="comparison-context__metric">
                <span className="comparison-context__label">Selected range</span>
                <strong>{periodLabel(query.start, query.end)}</strong>
            </span>
            <span className="comparison-context__metric">
                <span className="comparison-context__label">Compared with</span>
                <strong>{query.compare} · {periodLabel(compareStart, compareEnd)}</strong>
            </span>
            {hasTotals && (
                <>
                    <span className="comparison-context__metric">
                        <span className="comparison-context__label">Selected revenue</span>
                        <strong>{fmtMoney(currentRevenue, money)}</strong>
                    </span>
                    <span className="comparison-context__metric">
                        <span className="comparison-context__label">Compared revenue</span>
                        <strong>{fmtMoney(previousRevenue, money)}</strong>
                    </span>
                    <span className="comparison-context__metric">
                        <span className="comparison-context__label">Change</span>
                        <strong className={deltaClass}>{fmtSignedMoney(delta)} · {fmtPct(deltaPct)}</strong>
                    </span>
                </>
            )}
            <span className="comparison-context__note">
                {hasTotals ? '% Δ cards and change columns use this same comparison.' : 'This page uses the selected range and comparison range shown above.'}
            </span>
        </div>
    );
}

// The C Hub pages' date bar (Python app: looker_date_bar): dates and
// comparison only. Applying it resets the page's own filters, as the original
// GET form did.
export function DateBar({query, onApply}: {query: PageQuery; onApply: (next: PageQuery) => void}) {
    const config = useConfig();
    const [draft, setDraft] = useState(query);
    useEffect(() => setDraft(query), [query]);

    function setRange(range: string) {
        if (range === 'Custom' || !config.data) {
            setDraft(d => ({...d, range}));
            return;
        }
        const [start, end] = dateRangeFor(range, config.data.today, config.data.reportingWeekStart);
        setDraft(d => ({...d, range, start, end}));
    }

    return (
        <form className="filters looker-filters" onSubmit={e => { e.preventDefault(); onApply(draft); }}>
            <label>Date Range
                <LuxSelect options={DATE_RANGE_LABELS.map(l => ({value: l, label: l}))} value={draft.range} onChange={setRange}/>
            </label>
            <label>Start<input type="date" name="start" value={draft.start} onChange={e => setDraft(d => ({...d, start: e.target.value, range: 'Custom'}))}/></label>
            <label>End<input type="date" name="end" value={draft.end} onChange={e => setDraft(d => ({...d, end: e.target.value, range: 'Custom'}))}/></label>
            <label>Compare
                <LuxSelect options={COMPARE_LABELS.map(l => ({value: l, label: l}))} value={draft.compare} onChange={compare => setDraft(d => ({...d, compare}))}/>
            </label>
            <button type="submit">Apply</button>
        </form>
    );
}
