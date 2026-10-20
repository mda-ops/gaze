import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {FormEvent} from 'react';
import {api} from '../api/client';

// /settings and /data-sources (admins). Python app: settings, data_sources.
// Only the settings a page reads are here, and Data Sources keeps only its
// links (docs/rewrite/01-intended-differences.md).

interface SettingsValues {
    reporting_week_start: string;
    default_currency: string;
    timezone: string;
    unlock_threshold: number;
    anomaly_revenue_drop_pct: number;
    anomaly_revenue_spike_pct: number;
    revenue_catcher_base_url: string;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const NUMBERS: [keyof SettingsValues, string][] = [
    ['unlock_threshold', 'Unlock Threshold'],
    ['anomaly_revenue_drop_pct', 'Anomaly Revenue Drop Pct'],
    ['anomaly_revenue_spike_pct', 'Anomaly Revenue Spike Pct'],
];

const SETTINGS = ['settings'];

function Loading({error}: {error: Error | null}) {
    if (error) return <section className="panel"><h2>Could not load this page</h2><p className="note">{error.message}</p></section>;
    return <section className="panel"><p className="note">Loading…</p></section>;
}

export function SettingsPage() {
    const queryClient = useQueryClient();
    const {data, error} = useQuery({queryKey: SETTINGS, queryFn: () => api<{values: SettingsValues}>('/api/settings')});
    const save = useMutation({
        mutationFn: (values: SettingsValues) => api<{saved: boolean}>('/api/settings', {method: 'POST', body: values}),
        onSuccess: async () => {
            await queryClient.invalidateQueries({queryKey: SETTINGS});
            // Week start, currency and timezone also come with the app config.
            await queryClient.invalidateQueries({queryKey: ['config']});
        },
    });
    if (!data) return <Loading error={error}/>;
    const v = data.values;

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const text = (key: keyof SettingsValues) => String(form.get(key) ?? '').trim();
        save.mutate({
            reporting_week_start: text('reporting_week_start'),
            default_currency: text('default_currency'),
            timezone: text('timezone'),
            unlock_threshold: Number(text('unlock_threshold')),
            anomaly_revenue_drop_pct: Number(text('anomaly_revenue_drop_pct')),
            anomaly_revenue_spike_pct: Number(text('anomaly_revenue_spike_pct')),
            revenue_catcher_base_url: text('revenue_catcher_base_url'),
        });
    }

    return (
        <section className="panel">
            <h2>Settings</h2>
            <form className="settings-form" onSubmit={submit} onChange={() => save.reset()}>
                <label>Reporting Week Start
                    <select name="reporting_week_start" defaultValue={v.reporting_week_start}>
                        {WEEKDAYS.map(day => <option key={day}>{day}</option>)}
                    </select>
                </label>
                <label>Default Currency
                    <select name="default_currency" defaultValue={v.default_currency}>
                        <option>EUR</option>
                        <option>USD</option>
                    </select>
                </label>
                <label>Timezone<input name="timezone" defaultValue={v.timezone}/></label>
                {NUMBERS.map(([key, label]) => (
                    <label key={key}>{label}<input name={key} type="number" step="any" min="0" defaultValue={String(v[key])}/></label>
                ))}
                <label>Revenue Catcher Base Url<input name="revenue_catcher_base_url" type="url" defaultValue={v.revenue_catcher_base_url}/></label>
                <button disabled={save.isPending}>Save Settings</button>
            </form>
            {save.error && <p className="login-error">{save.error.message}</p>}
            {save.isSuccess && <p className="note">Settings saved.</p>}
        </section>
    );
}

export function DataSourcesPage() {
    const {data, error} = useQuery({
        queryKey: ['data-sources'],
        queryFn: () => api<{links: {label: string; note: string; url: string}[]}>('/api/data-sources'),
    });
    if (!data) return <Loading error={error}/>;
    return (
        <section className="panel">
            <h2>Data Sources</h2>
            <p className="note">Shortcuts to the external sources behind Gaze. Gaze reads its numbers directly from Flow's database; nothing here imports data.</p>
            {data.links.map(link => (
                <p key={link.label}>
                    <strong>{link.label}:</strong>{' '}
                    <a href={link.url} target="_blank" rel="noreferrer">{link.note}</a>
                </p>
            ))}
        </section>
    );
}
