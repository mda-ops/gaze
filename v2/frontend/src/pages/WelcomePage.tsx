import {Link} from 'react-router-dom';
import type {User} from '../api/auth';

const WELCOME_BOT_BY_USER: Record<string, string> = {
    anne: '/static/welcome-bots/anne.png',
    dusan: '/static/welcome-bots/dusan.png',
    atamay: '/static/welcome-bots/atamay.png',
    damian: '/static/welcome-bots/damian.png',
    myron: '/static/welcome-bots/myron.png',
    faruk: '/static/welcome-bots/faruk.png',
};
const DEFAULT_WELCOME_BOT = '/static/gaze-ai-bot-cutout.png';

export function WelcomePage({user}: {user: User}) {
    return (
        <section className="welcome-page">
            <div className="welcome-layout">
                <div className="welcome-bot-wrap" aria-hidden="true">
                    <img className="welcome-bot" src={WELCOME_BOT_BY_USER[user.key] ?? DEFAULT_WELCOME_BOT} alt=""/>
                </div>
                <div className="welcome-copy">
                    <p className="welcome-greeting"><span className="wave-hand" aria-hidden="true">👋</span> Hi, {user.name}.</p>
                    <h2>Welcome to GAZE.</h2>
                    <h3>Ready to see the bigger picture?</h3>
                    <p>Get a clear view of what&rsquo;s happening across the business - performance, revenue, teams, and key insights, all in one place.</p>
                    <Link className="welcome-logo-link" to="/c-hub/executive-overview" aria-label="Enter GAZE and open Executive Overview">
                        <img src="/static/gaze-wordmark.png" alt="Enter GAZE"/>
                    </Link>
                </div>
            </div>
        </section>
    );
}
