import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Link, NavLink, useNavigate} from 'react-router-dom';
import {useLogout, type User} from '../api/auth';
import {navGroupsFor, type NavGroup} from '../pages';
import {SiteBlocks} from './SiteBlocks';

// The page frame: sidebar (brand, navigation, profile menu) and page header.
// Markup and class names match the Python app's layout.html so gaze.css
// applies unchanged.

const OPEN_GROUPS_KEY = 'revenueAnalyticsOpenNavGroups';

function readOpenGroups(): Set<string> {
    try {
        return new Set((localStorage.getItem(OPEN_GROUPS_KEY) ?? '').split(',').filter(Boolean));
    } catch {
        return new Set();
    }
}

function saveOpenGroups(open: Set<string>) {
    try {
        localStorage.setItem(OPEN_GROUPS_KEY, [...open].join(','));
    } catch {
        // Storage unavailable (private mode): groups just won't be remembered.
    }
}

export function ProfileAvatar({user, className = 'profile-avatar'}: {user: User; className?: string}) {
    if (user.photoUrl) {
        return <span className={`${className} image-avatar`}><img src={user.photoUrl} alt={user.name}/></span>;
    }
    return <span className={className}>{(user.name || 'User').slice(0, 1).toUpperCase()}</span>;
}

function NavGroups({groups, currentPath}: {groups: NavGroup[]; currentPath: string}) {
    const activeGroup = groups.find(g => g.sections.some(s => s.pages.some(p => p.path === currentPath)))?.key;
    const [open, setOpen] = useState<Set<string>>(() => {
        const saved = readOpenGroups();
        const initial = new Set(groups.filter(g => g.key === activeGroup || saved.has(g.key)).map(g => g.key));
        if (!initial.size && groups[0]) initial.add(groups[0].key);
        return initial;
    });

    // Opening a page inside a closed group opens that group.
    useEffect(() => {
        if (activeGroup && !open.has(activeGroup)) setOpen(prev => new Set(prev).add(activeGroup));
    }, [activeGroup, open]);
    useEffect(() => saveOpenGroups(open), [open]);

    function toggle(key: string) {
        setOpen(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }

    return (
        <>
            {groups.map(group => (
                <div key={group.key} className={`nav-group${open.has(group.key) ? ' open' : ''}`} data-nav-group={group.key}>
                    <button type="button" className="nav-section nav-toggle" aria-expanded={open.has(group.key)} onClick={() => toggle(group.key)}>
                        {group.label}<span/>
                    </button>
                    <div className="nav-items">
                        {group.sections.map(section => (
                            <SectionLinks key={section.heading || 'main'} heading={section.heading} pages={section.pages}/>
                        ))}
                    </div>
                </div>
            ))}
        </>
    );
}

function SectionLinks({heading, pages}: {heading: string; pages: {path: string; label: string}[]}) {
    return (
        <>
            {heading && <span className="nav-subheading">{heading}</span>}
            {pages.map(page => (
                <NavLink key={page.path} to={page.path} end className={({isActive}) => (isActive ? 'active' : undefined)}>
                    {page.label}
                </NavLink>
            ))}
        </>
    );
}

function ProfileMenu({user}: {user: User}) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const logout = useLogout();
    const navigate = useNavigate();

    useEffect(() => {
        if (!open) return;
        const close = (event: MouseEvent | KeyboardEvent) => {
            if (event instanceof KeyboardEvent ? event.key === 'Escape' : !wrapRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('click', close);
        document.addEventListener('keydown', close);
        return () => {
            document.removeEventListener('click', close);
            document.removeEventListener('keydown', close);
        };
    }, [open]);

    async function logOut() {
        await logout.mutateAsync();
        navigate('/login');
    }

    return (
        <div ref={wrapRef} className={`profile-menu-wrap${open ? ' open' : ''}`}>
            <button type="button" className="profile-panel profile-trigger" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(o => !o)}>
                <ProfileAvatar user={user}/>
                <span>
                    <strong>{user.name}</strong>
                    <em>{user.title}</em>
                </span>
            </button>
            <div className="profile-menu" role="menu">
                <div className="profile-menu-head">
                    <ProfileAvatar user={user} className="profile-avatar menu-avatar"/>
                    <span>
                        <strong>{user.name}</strong>
                        <em>@{user.username}</em>
                    </span>
                </div>
                <Link to="/account" role="menuitem" onClick={() => setOpen(false)}>Account Settings</Link>
                <Link to="/account#photo" role="menuitem" onClick={() => setOpen(false)}>Add Photo</Link>
                <Link to="/account#security" role="menuitem" onClick={() => setOpen(false)}>Change Password</Link>
                {user.role === 'admin' && <Link to="/people-access" role="menuitem" onClick={() => setOpen(false)}>People Access</Link>}
                <a className="logout-link" href="/login" role="menuitem" onClick={e => { e.preventDefault(); void logOut(); }}>Log Out</a>
            </div>
        </div>
    );
}

// showBlocks: false for the "Not found" page, which the Python app served without the frame.
export function AppShell({user, title, currentPath, children, showBlocks = true}: {
    user: User; title: string; currentPath: string; children: ReactNode; showBlocks?: boolean;
}) {
    useEffect(() => {
        document.body.className = user.role === 'viewer' ? 'viewer-mode' : 'admin-mode';
        document.title = title === 'Welcome' ? 'Gaze' : `${title} · Gaze`;
    }, [user.role, title]);

    return (
        <>
            <aside className="sidebar">
                <Link className="brand" to="/c-hub/revenue" aria-label="Open GAZE Model Revenue Overview">
                    <span className="brand-copy">
                        <strong>GAZE</strong>
                        <em>your business seer</em>
                    </span>
                </Link>
                <nav>
                    <NavGroups groups={navGroupsFor(user)} currentPath={currentPath}/>
                </nav>
                <ProfileMenu user={user}/>
            </aside>
            <main>
                <header>
                    <div className="page-title-lockup">
                        <span className="agency-mark"><img src="/static/md-logo-cropped.png" alt="MD Agency"/></span>
                        <div>
                            <p className="eyebrow agency-eyebrow">MD Agency</p>
                            <h1>{title}</h1>
                            {user.role === 'viewer' && <span className="access-pill">Shared view</span>}
                        </div>
                    </div>
                </header>
                {children}
                {showBlocks && <SiteBlocks page={currentPath}/>}
            </main>
        </>
    );
}
