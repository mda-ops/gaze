import {fmtInt, fmtMoney, fmtPct, platformColorClass, type MoneyContext} from '../lib/format';

// The revenue cards and platform totals strip of the Model and Chatter Revenue
// pages, with the Python app's markup.

export function PlatformTotals({totals, money}: {totals: {platform: string; revenue: number; share: number}[]; money: MoneyContext}) {
    return (
        <div className="platform-total-strip">
            {totals.map(t => (
                <article key={t.platform} className="platform-total-card">
                    <span className={platformColorClass(t.platform)}>{t.platform}</span>
                    <strong className={platformColorClass(t.platform)}>{fmtMoney(t.revenue, money)}</strong>
                    <em>{fmtPct(t.share)} of selected revenue</em>
                </article>
            ))}
        </div>
    );
}

// One model or chatter card (Python app: c_revenue_breakdown_cards).
export function RevenueCard({name, card, money, headExtra}: {
    name: string;
    card: {total: number; subscriptionRevenue?: number; currentSubs?: number; agencies?: string[]; tiers?: string[]; platforms: {platform: string; revenue: number; share: number; currentSubs?: number}[]};
    money: MoneyContext;
    // Shown in the card head when there is no subscriber count (chatter cards: revenue per hour).
    headExtra?: string | null;
}) {
    const badges = [(card.agencies ?? []).join(' / '), (card.tiers ?? []).join(' / ')].filter(Boolean);
    return (
        <article className="model-revenue-card">
            <div className="model-revenue-card-head">
                <h3>{name}</h3>
                {card.currentSubs ? <span className="model-revenue-subs-total">{fmtInt(card.currentSubs)} subs</span>
                    : headExtra ? <span className="model-revenue-rate">{headExtra}</span> : null}
            </div>
            {badges.length > 0 && <div className="model-revenue-meta">{badges.map(b => <span key={b}>{b}</span>)}</div>}
            <strong>{fmtMoney(card.total, money)}</strong>
            {Boolean(card.subscriptionRevenue) && <span className="model-subscription-total">Subscriptions {fmtMoney(card.subscriptionRevenue ?? 0, money)}</span>}
            <div className="model-platform-splits">
                {card.platforms.map(p => {
                    const colour = platformColorClass(p.platform);
                    return (
                        <div key={p.platform} className="model-platform-row">
                            <span className={colour}>{p.platform}</span>
                            <strong className={colour}>{fmtMoney(p.revenue, money)}</strong>
                            <em>{p.currentSubs ? `${fmtInt(p.currentSubs)} subs` : ''}</em>
                            <div className="model-platform-track"><i className={colour} style={{width: `${p.share.toFixed(1)}%`}}/></div>
                        </div>
                    );
                })}
            </div>
        </article>
    );
}
