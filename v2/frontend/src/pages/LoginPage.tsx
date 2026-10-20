import {useEffect, useState, type FormEvent} from 'react';
import {useNavigate} from 'react-router-dom';
import {useLogin} from '../api/auth';

// Same markup as the Python app's login page (login-mode, login-panel).
export function LoginPage() {
    const login = useLogin();
    const navigate = useNavigate();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);

    useEffect(() => {
        document.body.className = 'login-mode';
        document.title = 'Login · Gaze';
    }, []);

    async function submit(event: FormEvent) {
        event.preventDefault();
        try {
            await login.mutateAsync({username, password});
            navigate('/', {replace: true});
        } catch {
            // Shown below from login.error.
        }
    }

    return (
        <main>
            <section className="login-panel">
                <img className="login-mark" src="/static/favicon.png" alt="GAZE"/>
                <h2>GAZE</h2>
                <p>Your business seer</p>
                {login.error && <p className="login-error">{login.error.message}</p>}
                <form className="login-form" onSubmit={submit}>
                    <label>Username
                        <input name="username" autoComplete="username" autoFocus placeholder="anne" value={username} onChange={e => setUsername(e.target.value)}/>
                    </label>
                    <label>Password
                        <span className="password-field">
                            <input type={showPassword ? 'text' : 'password'} name="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}/>
                            <button type="button" className={`password-toggle${showPassword ? ' is-visible' : ''}`} aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(s => !s)}>Show</button>
                        </span>
                    </label>
                    <button disabled={login.isPending}>Sign In</button>
                </form>
                <footer>MD Agency &middot; internal command hub</footer>
            </section>
        </main>
    );
}
