// Metric definitions shown as "i" tooltips on KPI cards (Python app:
// financials.METRIC_REGISTRY and metric_key_for_label).

interface MetricDefinition {
    label: string;
    definition: string;
    formula: string;
    // Colour the value green/red: only for genuine profit/loss metrics.
    profitLoss?: boolean;
}

const METRICS: Record<string, MetricDefinition> = {
    gross_revenue: {label: 'Gross Revenue', definition: 'Total revenue generated before deductions.', formula: ''},
    flow_manager_gross: {label: 'Flow Manager Gross', definition: 'Gross revenue on the realised Flow Manager Dashboard scope: tips and messages with an MD agency amount plus settled subscriptions. It excludes PPV and unsettled subscriptions.', formula: ''},
    flow_manager_net: {label: 'Flow Manager Net', definition: 'The total MD agency amount on the same realised Flow Manager Dashboard scope used for Flow Manager Gross.', formula: ''},
    external_revenue_splits: {label: 'External Revenue Splits', definition: 'Revenue allocated to platforms, creators, partners, or other external parties.', formula: ''},
    agency_revenue: {label: 'Agency Revenue', definition: 'Gross revenue remaining after external revenue splits.', formula: 'Gross Revenue − External Revenue Splits'},
    direct_revenue_costs: {label: 'Direct Revenue Costs', definition: 'Internal costs directly tied to generating or managing revenue.', formula: 'Commission + bonus + salary + manager cut'},
    chatter_commission: {label: 'Chatter Commission', definition: 'Commission allocated to chatters from eligible attributed revenue.', formula: ''},
    chatter_bonus: {label: 'Chatter Bonus', definition: "Bonus calculated from Flow's applicable team bonus rules.", formula: ''},
    chatter_salary: {label: 'Chatter Salary', definition: 'Recorded or configured salary attributable to the selected period.', formula: ''},
    manager_commission: {label: 'Chat Manager Commission', definition: "Commission allocated through Flow's effective-dated chat-manager rate.", formula: ''},
    net_revenue: {label: 'Net Revenue', definition: 'Agency revenue remaining after direct revenue costs.', formula: 'Agency Revenue − Direct Revenue Costs'},
    operating_expenses: {label: 'Operating Expenses', definition: 'Business running costs not already included in revenue splits or direct costs.', formula: ''},
    profit_loss: {label: 'P&L Profit/Loss', definition: 'Final profit or loss after direct costs and operating expenses.', formula: 'Net Revenue − Operating Expenses', profitLoss: true},
    profit_margin: {label: 'Profit Margin', definition: 'Final profit or loss as a share of gross revenue.', formula: 'P&L Profit/Loss ÷ Gross Revenue', profitLoss: true},
    net_revenue_margin: {label: 'Net Revenue Margin', definition: 'Net revenue as a share of gross revenue.', formula: 'Net Revenue ÷ Gross Revenue'},
    revenue_per_hour: {label: 'Revenue / Hour', definition: 'Selected revenue divided by recorded shift hours.', formula: ''},
    inactivity_cost: {label: 'Inactivity Cost', definition: 'Estimated revenue lost during scheduled inactive time.', formula: ''},
    md_earnings_after_expenses: {label: 'MD Earnings After Expenses', definition: 'The retained management pool after tracked operating expenses.', formula: 'Management pool − Operating Expenses', profitLoss: true},
};

const ALIASES: Record<string, string> = {
    'gross rev': 'gross_revenue', 'gross profit': 'agency_revenue', 'net rev': 'net_revenue',
    'net margin': 'net_revenue_margin', 'p&l profit': 'profit_loss',
    'total operating expenses': 'operating_expenses', 'flow chatter bonus': 'chatter_bonus',
    'chatter salary cost': 'chatter_salary', 'chat manager cuts': 'manager_commission',
    'md earnings after expenses': 'md_earnings_after_expenses',
};

// Every registered metric, in registry order.
export function allMetrics(): MetricDefinition[] {
    return Object.values(METRICS);
}

// By explicit key (Python: kpi_card_html(..., metric_key)), else by label.
export function metricFor(label: string, key?: string): MetricDefinition | null {
    if (key) return METRICS[key] ?? null;
    return metricForLabel(label);
}

export function metricForLabel(label: string): MetricDefinition | null {
    const clean = label.trim().toLowerCase();
    const key = Object.keys(METRICS).find(k => METRICS[k].label.toLowerCase() === clean) ?? ALIASES[clean];
    return key ? METRICS[key] : null;
}
