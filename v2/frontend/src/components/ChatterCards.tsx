import {fmtCompact, fmtMoney, fmtNum, type MoneyContext} from '../lib/format';

// Chatter cards of the Performance Hubs (Python app: c_scheduled_chatter_cards,
// c_capacity_chatter_cards). At most 80 cards, as in the Python app.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "%d %b %Y" of the grade timestamp, or "Not graded".
function gradeDate(value: string | null): string {
    if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return 'Not graded';
    return `${value.slice(8, 10)} ${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}`;
}

function tierClass(tier: string): string {
    return ['A', 'B', 'C'].includes(tier) ? `tier-${tier.toLowerCase()}` : 'tier-pending';
}

interface BaseChatter {
    chatter: string;
    tier: string;
    team: string;
    skillGrade: number;
    chatQuality: number;
    activityBehaviour: number;
    revenue: number;
    scorePending: boolean;
    hrProfileFound: boolean;
    latestGradeDate: string | null;
}

function Head({c}: {c: BaseChatter}) {
    return (
        <div className="scheduled-chatter-head">
            <div><h3>{c.chatter || 'Unknown'}</h3><span>{c.team || 'Unknown'}</span></div>
            <div className="scheduled-tier-lockup">
                <strong className={tierClass(c.tier)}>{c.tier || 'Pending score'}</strong>
                <small>Last graded<br/>{gradeDate(c.latestGradeDate)}</small>
            </div>
        </div>
    );
}

function Scores({c}: {c: BaseChatter}) {
    return (
        <div className="scheduled-score-grid">
            <span>Skill <strong>{fmtNum(c.skillGrade)}</strong></span>
            <span>Chat Quality <strong>{fmtNum(c.chatQuality)}</strong></span>
            <span>Activity / Behaviour <strong>{fmtNum(c.activityBehaviour)}</strong></span>
        </div>
    );
}

export function ScheduledChatterCards({rows, money}: {
    rows: (BaseChatter & {scheduledHours: number; operatingPotential: number; revPerHour: number})[];
    money: MoneyContext;
}) {
    if (!rows.length) return <div className="empty">No scheduled chatter rows for the selected period.</div>;
    return (
        <section className="scheduled-chatter-grid">
            {rows.slice(0, 80).map((c, i) => (
                <article key={`${c.chatter}-${i}`} className="scheduled-chatter-card">
                    <Head c={c}/>
                    <div className="scheduled-chatter-main">
                        <div><span>Operating Potential</span><strong>{fmtCompact(c.operatingPotential)}</strong></div>
                        <div><span>Scheduled Hours</span><strong>{fmtNum(c.scheduledHours)}</strong></div>
                        <div><span>Revenue</span><strong>{fmtMoney(c.revenue, money)}</strong></div>
                        <div><span>Rev / Hour</span><strong>{fmtMoney(c.revPerHour, money)}</strong></div>
                    </div>
                    <Scores c={c}/>
                    <em className="scheduled-status">{c.scorePending ? 'Pending score' : c.hrProfileFound ? 'Matched HR' : 'Needs HR profile'}</em>
                </article>
            ))}
        </section>
    );
}

export function CapacityChatterCards({rows, money}: {
    rows: (BaseChatter & {weeklyCapacityHours: number; scheduledHours: number; capacityGapHours: number; utilizationPct: number;
        qualityAdjustedCapacity: number; capacityMissing: boolean; capacitySource: string})[];
    money: MoneyContext;
}) {
    if (!rows.length) return <div className="empty">No chatter rows for the current week.</div>;
    return (
        <section className="scheduled-chatter-grid">
            {rows.slice(0, 80).map((c, i) => {
                const source = c.capacitySource || 'Profile capacity';
                const status = c.capacityMissing ? 'Missing weekly capacity'
                    : source === 'RevenueCatcher schedule' ? `Capacity: ${source}`
                        : c.scorePending ? 'Pending score' : c.hrProfileFound ? 'Matched HR' : 'Needs HR profile';
                return (
                    <article key={`${c.chatter}-${i}`} className="scheduled-chatter-card capacity-chatter-card">
                        <Head c={c}/>
                        <div className="scheduled-chatter-main">
                            <div><span>Weekly Capacity</span><strong>{c.capacityMissing ? 'Missing capacity' : `${fmtNum(c.weeklyCapacityHours)}h`}</strong></div>
                            <div><span>Chatter Hours</span><strong>{fmtNum(c.scheduledHours)}h</strong></div>
                            <div><span>Unused Capacity</span><strong>{fmtNum(c.capacityGapHours)}h</strong></div>
                            <div><span>Utilization</span><strong>{fmtNum(c.utilizationPct)}%</strong></div>
                            <div><span>Team Strength</span><strong>{fmtNum(c.qualityAdjustedCapacity)}h</strong></div>
                            <div><span>Revenue</span><strong>{fmtMoney(c.revenue, money)}</strong></div>
                        </div>
                        <Scores c={c}/>
                        <em className="scheduled-status">{status}</em>
                    </article>
                );
            })}
        </section>
    );
}
