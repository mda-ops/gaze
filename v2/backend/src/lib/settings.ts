import type pg from 'pg';

// Settings stored in Gaze's database (app_settings), with the Python app's
// defaults (app/config.py DEFAULT_SETTINGS) for anything not stored.

export const DEFAULT_SETTINGS = {
    reporting_week_start: 'Friday',
    default_currency: 'EUR',
    timezone: 'Europe/Amsterdam',
    unlock_threshold: 199.0,
    anomaly_revenue_drop_pct: 30.0,
    anomaly_revenue_spike_pct: 40.0,
    english_chatter_salary_usd_per_hour: 2.0,
    // The department running costs.
    operating_expenses: [{"department": "Finance", "person": "Myron", "monthly_amount": 5000.0, "currency": "EUR"}, {"department": "Finance", "person": "Melika", "monthly_amount": 600.0, "currency": "EUR"}, {"department": "Finance", "person": "Mihajlo", "monthly_amount": 900.0, "currency": "EUR"}, {"department": "Ops", "person": "Dusan", "monthly_amount": 7157.4, "currency": "EUR"}, {"department": "Ops", "person": "Atamay", "monthly_amount": 1700.0, "currency": "EUR"}, {"department": "Ops", "person": "Faruk", "monthly_amount": 800.0, "currency": "EUR"}, {"department": "Ops", "person": "Juul", "monthly_amount": 2000.0, "currency": "EUR"}, {"department": "Ops", "person": "Marli", "monthly_amount": 600.0, "currency": "USD"}, {"department": "Ops", "person": "Lowella", "monthly_amount": 450.0, "currency": "USD"}, {"department": "Ops", "person": "Kelechi", "monthly_amount": 1700.0, "currency": "USD"}, {"department": "Quality", "person": "Anne", "monthly_amount": 1100.0, "currency": "USD"}, {"department": "Quality", "person": "Zyrose", "monthly_amount": 400.0, "currency": "USD"}, {"department": "Marketing", "person": "Beni", "monthly_amount": 2800.0, "currency": "EUR"}, {"department": "Marketing", "person": "Lisa", "monthly_amount": 1400.0, "currency": "EUR"}, {"department": "Marketing", "person": "Nerj", "monthly_amount": 1800.0, "currency": "EUR"}, {"department": "Marketing", "person": "Alona", "monthly_amount": 600.0, "currency": "USD"}, {"department": "Marketing", "person": "Jasmine", "monthly_amount": 300.0, "currency": "USD"}, {"department": "BD", "person": "Mauro", "monthly_amount": 3000.0, "currency": "EUR"}, {"department": "HR", "person": "Elethu", "monthly_amount": 1400.0, "currency": "USD"}, {"department": "HR", "person": "Tirza", "monthly_amount": 250.0, "currency": "USD"}, {"department": "Chat Dept Managers", "person": "Daniel", "monthly_amount": 2000.0, "currency": "EUR"}, {"department": "Chat Dept Managers", "person": "Tineke", "monthly_amount": 3500.0, "currency": "EUR"}],
} as const;

type Scalar<T> = T extends string ? string : T extends number ? number : unknown;
export type Settings = {-readonly [K in keyof typeof DEFAULT_SETTINGS]: Scalar<(typeof DEFAULT_SETTINGS)[K]>}
    & Record<string, unknown>;

export async function loadSettings(pool: pg.Pool | null): Promise<Settings> {
    const settings: Record<string, unknown> = {...DEFAULT_SETTINGS};
    if (pool) {
        const rows = (await pool.query<{key: string; value: unknown}>('SELECT key, value FROM app_settings')).rows;
        for (const row of rows) settings[row.key] = row.value;
    }
    return settings as Settings;
}
