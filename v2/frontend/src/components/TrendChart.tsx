import {useState} from 'react';
import {chartMoney, shortDateLabel} from '../lib/format';

// Month-to-date revenue bars with platform splits and an optional previous-
// month overlay (Python app: the trend panel + app.js drawTrendChart).

export interface TrendDay {
    date: string;
    revenue: number;
    platforms: {platform: string; revenue: number}[];
}

const BAR_HEIGHT = 235;

function platformClass(platform: string): string {
    const label = platform.toLowerCase();
    if (label.includes('f2f')) return 'platform-f2f';
    if (label.includes('knky') || label.includes('kinky')) return 'platform-knky';
    if (label === 'of' || label.includes('onlyfans') || label.includes('only fans')) return 'platform-of';
    return 'platform-other';
}

function Bar({day, max}: {day: TrendDay; max: number}) {
    const value = day.revenue || 0;
    const segments = day.platforms.filter(p => p.revenue > 0);
    const stacked = segments.length > 0 && value > 0;
    return (
        <div className={`bar${stacked ? ' stacked-bar' : ''}`} style={{height: `${Math.max(4, value / max * BAR_HEIGHT)}px`}}
             data-label={`${day.date}: ${chartMoney(value)}`}>
            {stacked && (
                <div className="bar-stack">
                    {segments.map(p => (
                        <span key={p.platform} className={`bar-segment ${platformClass(p.platform)}`}
                              style={{height: `${Math.max(2, p.revenue / value * 100)}%`}} title={`${p.platform}: ${chartMoney(p.revenue)}`}/>
                    ))}
                </div>
            )}
            <span className="bar-value">{chartMoney(value)}</span>
            <span className="bar-date">{shortDateLabel(day.date)}</span>
        </div>
    );
}

export function TrendChart({current, previous, previousLabel, start, today}: {
    current: TrendDay[];
    previous: TrendDay[];
    previousLabel: string;
    start: string;
    today: string;
}) {
    const [compare, setCompare] = useState(false);
    const shown = current.slice(0, 40);
    const shownPrevious = previous.slice(0, 40);
    const max = Math.max(...(compare ? [...shown, ...shownPrevious] : shown).map(d => d.revenue || 0), 1);

    return (
        <section className="panel trend-panel">
            <div className="panel-heading-row">
                <div>
                    <h2>Revenue Trend</h2>
                    <p className="note">Month to date: {start} to {today}</p>
                </div>
                <button className={`button ghost trend-compare-toggle${compare ? ' active' : ''}`} type="button" aria-pressed={compare}
                        onClick={() => setCompare(c => !c)}>
                    {compare ? `Hide ${previousLabel}` : 'Compare to Previous Month'}
                </button>
            </div>
            <div id="trendChart" className="chart trend-chart">
                {shown.map(day => <Bar key={day.date} day={day} max={max}/>)}
                {compare && (
                    <div className="trend-comparison-bars">
                        {shownPrevious.map(day => (
                            <div key={day.date} className="trend-comparison-slot">
                                <div className="trend-comparison-bar" style={{height: `${Math.max(4, (day.revenue || 0) / max * BAR_HEIGHT)}px`}}
                                     data-label={`${day.date}: ${chartMoney(day.revenue)}`}/>
                                <span className="trend-comparison-value">{chartMoney(day.revenue)}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
