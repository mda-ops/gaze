import {useEffect, useState, type FormEvent} from 'react';
import {useSearchParams} from 'react-router-dom';
import {useAsk, type AskData} from '../api/pages';
import {ComparisonContext, FilterBar} from '../components/FilterBar';
import {fmtMoney, fmtNum, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';

// /ask (Python app: ask): answers one of three fixed questions about chatters.

function answerText(answer: AskData['answer'], money: MoneyContext): string {
    switch (answer.kind) {
        case 'improved':
            return `${answer.chatter} improved the most, up ${fmtMoney(answer.changeAmount, money)}.`;
        case 'highHours':
            return `${answer.chatter} has high hours with relatively low revenue/hour: ${fmtNum(answer.hours)} hours and ${fmtMoney(answer.revenuePerHour, money)}/hour.`;
        case 'bestRate':
            return `${answer.chatter} has the highest revenue/hour at ${fmtMoney(answer.revenuePerHour, money)}.`;
        default:
            return 'No data available for the selected period.';
    }
}

export function AskPage() {
    const [query, setQuery] = usePageQuery('Today');
    const [params, setParams] = useSearchParams();
    const {data, error, isFetching} = useAsk(query, params.get('question'));
    const [draft, setDraft] = useState('');
    useEffect(() => { if (data) setDraft(data.question); }, [data?.question]);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const money: MoneyContext = {currency: query.currency, eurUsdRate: data.eurUsdRate};
    // As in the Python form, asking sends only the question: the period and
    // filters go back to their defaults.
    function submit(event: FormEvent) {
        event.preventDefault();
        setParams(new URLSearchParams({question: draft}));
    }
    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <FilterBar query={query} options={data.filterOptions} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.period.compareStart} compareEnd={data.period.compareEnd}
                               currentRevenue={data.comparison.currentRevenue} previousRevenue={data.comparison.previousRevenue} money={money}/>
            <section className="panel"><h2>Ask Your Data</h2>
                <form onSubmit={submit}>
                    <input className="wide" name="question" value={draft} onChange={e => setDraft(e.target.value)}/>
                    <button>Ask</button>
                </form>
                <p className="answer">{answerText(data.answer, money)}</p>
            </section>
        </div>
    );
}
