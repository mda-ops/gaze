import {useEffect, useState, type FormEvent} from 'react';
import {useNavigate} from 'react-router-dom';
import {readFileBase64, useChangePassword, useProfile, useSaveProfile, type Profile} from '../api/account';
import {useLogout, type User} from '../api/auth';
import {ProfileAvatar} from '../components/AppShell';

// /account (Python app: account_page_content): every user's own profile and password.

function PasswordInput({name, value, onChange}: {name: string; value: string; onChange: (value: string) => void}) {
    const [visible, setVisible] = useState(false);
    return (
        <span className="password-field">
            <input type={visible ? 'text' : 'password'} name={name} autoComplete="new-password" value={value} onChange={e => onChange(e.target.value)}/>
            <button type="button" className={`password-toggle${visible ? ' is-visible' : ''}`} aria-label={visible ? 'Hide password' : 'Show password'}
                    onClick={() => setVisible(v => !v)}>Show</button>
        </span>
    );
}

const pyTitle = (text: string) => text.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());

function ProfileForm({profile}: {profile: Profile}) {
    const save = useSaveProfile();
    const [draft, setDraft] = useState({name: profile.name, username: profile.username, email: profile.email, photoUrl: profile.photoUrl});
    const [file, setFile] = useState<File | null>(null);
    const [saved, setSaved] = useState(false);
    useEffect(() => setDraft({name: profile.name, username: profile.username, email: profile.email, photoUrl: profile.photoUrl}), [profile]);

    async function submit(event: FormEvent) {
        event.preventDefault();
        const photo = file ? {fileName: file.name, data: await readFileBase64(file)} : null;
        await save.mutateAsync({...draft, photo});
        setFile(null);
        setSaved(true);
    }
    const field = (key: keyof typeof draft) => ({value: draft[key], onChange: (e: {target: {value: string}}) => setDraft(d => ({...d, [key]: e.target.value}))});
    return (
        <form className="panel account-card" id="profile" onSubmit={submit}>
            <h2>Profile</h2>
            {saved && <p className="success-note">Profile saved.</p>}
            {save.error && <p className="login-error">{save.error.message}</p>}
            <label>Name<input name="name" {...field('name')}/></label>
            <label>Username<input name="username" {...field('username')}/></label>
            <label>Email<input type="email" name="email" placeholder="name@company.com" {...field('email')}/></label>
            <label id="photo">Add Photo
                <input type="file" name="photo_file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => setFile(e.target.files?.[0] ?? null)}/>
            </label>
            <label>Photo Link<input name="photo_url" placeholder="Optional image link" {...field('photoUrl')}/></label>
            <button disabled={save.isPending}>Save Profile</button>
        </form>
    );
}

function PasswordForm({onFailed}: {onFailed: (failed: boolean) => void}) {
    const change = useChangePassword();
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [saved, setSaved] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        try {
            await change.mutateAsync({newPassword, confirmPassword});
            setSaved(true);
            onFailed(false);
            setNewPassword('');
            setConfirmPassword('');
        } catch {
            setSaved(false);
            onFailed(true);
        }
    }
    return (
        <form className="panel account-card" id="security" onSubmit={submit}>
            <h2>Security</h2>
            {saved && <p className="success-note">Password updated for this profile.</p>}
            <label>New Password<PasswordInput name="new_password" value={newPassword} onChange={setNewPassword}/></label>
            <label>Confirm Password<PasswordInput name="confirm_password" value={confirmPassword} onChange={setConfirmPassword}/></label>
            <button disabled={change.isPending}>Change Password</button>
            <p className="note">Password changes are saved for this selected person. Admin access still uses the private admin password.</p>
        </form>
    );
}

export function AccountPage({user}: {user: User}) {
    const {data: profile, error} = useProfile();
    const logout = useLogout();
    const navigate = useNavigate();
    const [passwordFailed, setPasswordFailed] = useState(false);

    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!profile) return <section className="panel"><p className="note">Loading…</p></section>;

    async function logOut() {
        await logout.mutateAsync();
        navigate('/login');
    }
    return (
        <>
            <section className="account-hero panel">
                <div className="account-cover"/>
                <div className="account-identity">
                    <ProfileAvatar user={{...user, name: profile.name, photoUrl: profile.photoUrl}} className="profile-avatar account-avatar"/>
                    <span><strong>{profile.name}</strong><em>@{profile.username}</em></span>
                </div>
                <div className="account-actions">
                    <a className="button ghost" href="/login" onClick={e => { e.preventDefault(); void logOut(); }}>Log Out</a>
                </div>
                <div className="account-stats">
                    <div><span>Access</span><strong>{pyTitle(profile.role)}</strong></div>
                    <div><span>Role</span><strong>{profile.title}</strong></div>
                    <div><span>Email</span><strong>{profile.email || 'Add an email address'}</strong></div>
                </div>
            </section>
            <section className="account-grid">
                <ProfileForm profile={profile}/>
                <PasswordForm onFailed={setPasswordFailed}/>
            </section>
            {passwordFailed && (
                <section className="notice"><strong>Password not saved:</strong> enter the same password in both boxes.</section>
            )}
        </>
    );
}
