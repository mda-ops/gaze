import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Fragment, useEffect, useState, type FormEvent} from 'react';
import {api} from '../api/client';
import {C_HUB_SECTIONS, CORE_PAGES, HUB_PAGES, REPORT_PAGES, type PageLink} from '../pages';

// /people-access and /permission-groups (Python app: people_access): the pages
// each viewer may open.

interface Person {
    key: string;
    name: string;
    title: string;
    role: 'admin' | 'viewer';
    allowedRoutes: string[];
}

const SECTIONS: [string, PageLink[]][] = [
    ['Core', CORE_PAGES],
    ['Reports', REPORT_PAGES],
    ['C Hub', C_HUB_SECTIONS.flatMap(s => s.pages)],
    ['Hub', HUB_PAGES],
];

const PEOPLE = ['people-access'];

export function PeopleAccessPage() {
    const queryClient = useQueryClient();
    const {data, error} = useQuery({queryKey: PEOPLE, queryFn: () => api<{people: Person[]}>('/api/people-access')});
    const save = useMutation({
        mutationFn: (routes: Record<string, string[]>) => api('/api/people-access', {method: 'POST', body: {routes}}),
        onSuccess: () => queryClient.invalidateQueries({queryKey: PEOPLE}),
    });
    const [checked, setChecked] = useState<Record<string, Set<string>>>({});
    useEffect(() => {
        if (data) setChecked(Object.fromEntries(data.people.map(p => [p.key, new Set(p.allowedRoutes)])));
    }, [data]);

    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    if (!data) return <section className="panel"><p className="note">Loading…</p></section>;

    function toggle(key: string, path: string) {
        setChecked(current => {
            const next = new Set(current[key]);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return {...current, [key]: next};
        });
    }
    function submit(event: FormEvent) {
        event.preventDefault();
        save.mutate(Object.fromEntries(Object.entries(checked).map(([key, paths]) => [key, [...paths]])));
    }

    return (
        <>
            <section className="panel permission-panel">
                <h2>People Access</h2>
                <p className="note">Use this when you share GAZE. Pick each person at login, then GAZE only shows the pages you allow here. Admin can still access everything.</p>
                <form className="permission-form" onSubmit={submit}>
                    {data.people.map(person => (
                        <div key={person.key} className="permission-group-card people-card">
                            <div>
                                <span className="permission-kicker">{person.title}</span>
                                <h3>{person.name}</h3>
                                <p>{person.role === 'admin' ? 'You. Full admin/editor access.' : 'Choose exactly what this person can open in the shared view.'}</p>
                            </div>
                            <div className="permission-list">
                                {person.role === 'admin' ? <p className="note">Admin access: can see and edit everything.</p> : SECTIONS.map(([label, pages]) => (
                                    <Fragment key={label}>
                                        <h4>{label}</h4>
                                        {pages.map(page => (
                                            <label key={page.path} className="permission-row compact">
                                                <input type="checkbox" name={`allowed_route__${person.key}`} value={page.path}
                                                       checked={checked[person.key]?.has(page.path) ?? false} onChange={() => toggle(person.key, page.path)}/>
                                                <span>
                                                    <strong>{page.label}</strong>
                                                    <em>{page.path === '/c-hub' ? 'Main C Hub landing page' : 'Visible when enabled'}</em>
                                                </span>
                                            </label>
                                        ))}
                                    </Fragment>
                                ))}
                            </div>
                        </div>
                    ))}
                    <button type="submit" disabled={save.isPending}>Save People Access</button>
                </form>
            </section>
            <section className="panel permission-panel">
                <h2>Admin Editing</h2>
                <p className="note">For now, editing is admin-only through simple controls like this page. A true drag-and-drop editor is possible, but it needs a separate build step so changes stay reliable and do not break the shared dashboards.</p>
            </section>
        </>
    );
}
