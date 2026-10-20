import {useEffect, useMemo, useState, type FormEvent} from 'react';
import {useLocation, useSearchParams} from 'react-router-dom';
import type {User} from '../api/auth';
import {useTransactions, type TransactionsData} from '../api/pages';
import {DataTable, type Column} from '../components/DataTable';
import {ComparisonContext, FilterBar} from '../components/FilterBar';
import {LuxSelect} from '../components/LuxSelect';
import {downloadCsv} from '../lib/csv';
import {fmtMoney, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';

// /transactions and /c-hub/transactions (Python app: transactions):
// high-value transactions of the chosen types at or above a threshold.

type Row = TransactionsData['rows'][number];

function columns(money: MoneyContext): Column<Row>[] {
    return [
        {label: 'creator', value: r => r.creator},
        {label: 'date', value: r => r.date},
        {label: 'timestamp', value: r => r.timestamp},
        {label: 'amount', value: r => r.amount, text: r => fmtMoney(r.amount, money)},
        {label: 'transaction_type', value: r => r.transactionType},
        {label: 'chatter', value: r => r.chatter},
        {label: 'chatter_status', value: r => r.chatterStatus},
        {label: 'platform', value: r => r.platform},
    ];
}

function TypeThresholdForm({types, threshold, typeOptions, onApply}: {
    types: string[];
    threshold: number;
    typeOptions: string[];
    onApply: (types: string[], threshold: string) => void;
}) {
    const [draftTypes, setDraftTypes] = useState(types);
    const [draftThreshold, setDraftThreshold] = useState(String(threshold));
    useEffect(() => { setDraftTypes(types); setDraftThreshold(String(threshold)); }, [types, threshold]);

    function submit(event: FormEvent) {
        event.preventDefault();
        onApply(draftTypes, draftThreshold);
    }

    return (
        <form className="filters" onSubmit={submit}>
            <label>Transaction Type
                <LuxSelect multiple options={typeOptions.map(t => ({value: t, label: t}))} value={draftTypes} onChange={setDraftTypes}/>
            </label>
            <label>Amount Threshold<input type="number" name="threshold" step="1" value={draftThreshold} onChange={e => setDraftThreshold(e.target.value)}/></label>
            <button>Find</button>
        </form>
    );
}

export function TransactionsPage({user}: {user: User}) {
    const {pathname} = useLocation();
    const apiPath = pathname.startsWith('/c-hub') ? '/api/pages/c-hub-transactions' : '/api/pages/transactions';
    const [query, setQuery] = usePageQuery('Today');
    const [params, setParams] = useSearchParams();
    const extra = useMemo(() => {
        const search = new URLSearchParams();
        for (const type of params.getAll('tx_type')) search.append('tx_type', type);
        if (params.get('threshold')) search.set('threshold', params.get('threshold')!);
        return search;
    }, [params]);
    const {data, error, isFetching} = useTransactions(apiPath, query, extra);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    const tableColumns = columns(money);

    // Unlike the Python form, applying keeps the selected period.
    function applyTypes(types: string[], threshold: string) {
        const search = new URLSearchParams(params);
        search.delete('tx_type');
        search.delete('threshold');
        for (const type of types) search.append('tx_type', type);
        if (threshold) search.set('threshold', threshold);
        setParams(search);
    }

    function exportCsv() {
        downloadCsv(`transactions_${query!.start}_${query!.end}.csv`, tableColumns.map(c => c.label),
            data!.rows.map(row => tableColumns.map(c => c.value(row))));
    }

    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <FilterBar query={query} options={data.filterOptions} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            <TypeThresholdForm types={data.types} threshold={data.threshold} typeOptions={data.filterOptions.transaction_type} onApply={applyTypes}/>
            <section className="panel">
                <h2>High-Value Transactions</h2>
                <DataTable columns={tableColumns} rows={data.rows}/>
            </section>
            {user.role === 'admin' && data.rows.length > 0 && (
                <p><button type="button" className="button" onClick={exportCsv}>Export CSV</button></p>
            )}
        </div>
    );
}
