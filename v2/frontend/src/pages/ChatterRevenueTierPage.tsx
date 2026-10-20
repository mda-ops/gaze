import {useChatterRevenueTier} from '../api/pages';
import {ComparisonContext, DateBar} from '../components/FilterBar';
import {grouped, type MoneyContext} from '../lib/format';
import {usePageQuery} from '../lib/pageQuery';

// /c-hub/chatter-revenue-tier (Python app: c_hub_chatter_revenue_tier):
// every model's tier per completed month from monthly tips + messages.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ARROWS: Record<string, string> = {up: '↑', down: '↓', same: '→'};

// Always EUR, as in the Python app (this page has no currency selector).
const money = (value: number) => `€${grouped(value, 2)}`;
const longMonth = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const shortMonth = (month: string) => `${longMonth(month).slice(0, 3)} ${month.slice(0, 4)}`;

export function ChatterRevenueTierPage() {
    const [query, setQuery] = usePageQuery('This month');
    const {data, error, isFetching} = useChatterRevenueTier(query);

    if (!query) return null;
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    const t = data.thresholds;
    const range = data.months.length ? `${shortMonth(data.months[0])} to ${shortMonth(data.months[data.months.length - 1])}` : 'No revenue months yet';
    const tiles: [string, string, string][] = [
        ['Months', String(data.months.length), range],
        ['Tier A', String(data.latestCounts.A), `monthly revenue >= ${money(t.A)}`],
        ['Tier B', String(data.latestCounts.B), `monthly revenue ${money(t.B)} - ${money(t.A)}`],
        ['Tier C', String(data.latestCounts.C), `monthly revenue below ${money(t.B)}`],
    ];
    const eur: MoneyContext = {currency: 'EUR', eurUsdRate: 1};

    return (
        <div style={isFetching ? {opacity: 0.6, transition: 'opacity 0.2s'} : undefined}>
            <DateBar query={query} onApply={setQuery}/>
            <ComparisonContext query={query} compareStart={data.comparePeriod.compareStart} compareEnd={data.comparePeriod.compareEnd}
                               currentRevenue={null} previousRevenue={null} money={eur}/>
            <div className="c-suite-page">
                <section className="notice compact-source tier-matrix-note">
                    Monthly model view using monthly revenue tiers: A = €50k+ per month, B = €15k-€50k per month, C = below €15k per month.
                    Amounts shown are total tips + messages from all platforms, excluding the current in-progress month.
                </section>
                <section className="c-stat-strip">
                    {tiles.map(([label, value, hint]) => (
                        <div key={label} className="c-stat-tile"><span>{label}</span><strong>{value}</strong><em>{hint}</em></div>
                    ))}
                </section>
                <section className="panel tier-matrix-panel">
                    <div className="panel-heading-row">
                        <div>
                            <h2>Monthly Tier Matrix</h2>
                            <p className="note">The letter is based on total monthly tips + messages revenue. The amount under the letter is the model&apos;s total tips + messages for the full month; arrows compare each model against their previous recorded month.</p>
                        </div>
                    </div>
                    {data.rows.length ? (
                        <div className="tier-matrix-scroll">
                            <table className="tier-matrix-table">
                                <thead>
                                    <tr><th className="model-name">Model</th>{data.months.map(m => <th key={m}>{shortMonth(m)}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {data.rows.map(row => (
                                        <tr key={row.model}>
                                            <th className="model-name">{row.model}</th>
                                            {row.cells.map(cell => (
                                                <td key={cell.month} className={`tier-cell tier-${cell.tier ? cell.tier.toLowerCase() : 'empty'}`}
                                                    title={cell.tier ? `${longMonth(cell.month)}: ${money(cell.revenue)} monthly tips + messages` : `${longMonth(cell.month)}: no tier revenue`}>
                                                    {cell.tier
                                                        ? <><strong>{cell.tier}<span>{ARROWS[cell.arrow] ?? ''}</span></strong><small>{money(cell.revenue)}</small></>
                                                        : <><em>-</em><small>€0.00</small></>}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : <div className="empty">No model revenue tiers are available yet.</div>}
                </section>
            </div>
        </div>
    );
}
