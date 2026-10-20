// Every page of Gaze and where it sits in the sidebar. Mirrors the Python
// app's CORE_PAGES, REPORT_PAGES, C_HUB_GROUPS, HUB_PAGES and admin links.
// To add a page: add it here, then add its route in App.tsx.

export interface PageLink {
    path: string;
    label: string;
}

export interface NavGroup {
    // Key used to remember open groups in localStorage (same keys as the Python app).
    key: string;
    label: string;
    // C Hub pages are split into labelled subgroups.
    sections: {heading: string; pages: PageLink[]}[];
}

export const WELCOME_PAGE: PageLink = {path: '/', label: 'Welcome'};

export const C_HUB_SECTIONS: {heading: string; pages: PageLink[]}[] = [
    {heading: '', pages: [{path: '/c-hub/executive-overview', label: 'Executive Overview'}]},
    {heading: 'Chat Dept', pages: [
        {path: '/c-hub/revenue', label: 'Model Revenue Overview'},
        {path: '/c-hub/chatter-revenue', label: 'Chatter Revenue Overview'},
        {path: '/c-hub/inactivity', label: 'Inactivity'},
        {path: '/c-hub/performance', label: 'Performance Hub'},
        {path: '/c-hub/performance-2', label: 'Performance Hub 2'},
    ]},
    {heading: 'Finance', pages: [
        {path: '/c-hub/commissions', label: 'Commissions'},
        {path: '/c-hub/transactions', label: 'Transactions'},
        {path: '/c-hub/target-monitoring', label: 'Target Monitoring'},
        {path: '/c-hub/chatter-revenue-tier', label: 'Chatting Revenue Tier'},
    ]},
    {heading: 'Ops', pages: [
        {path: '/c-hub', label: 'Marketing & Operations Overview'},
        {path: '/c-hub/compliance', label: 'Compliance'},
        {path: '/c-hub/tickets', label: 'Interdepartmental Tickets'},
    ]},
    {heading: 'Mktg', pages: [
        {path: '/c-hub/marketing-ads', label: 'Marketing | Ads'},
        {path: '/c-hub/models-socials', label: 'Models Socials'},
        {path: '/c-hub/of-new-fans', label: 'OF New Fan Growth'},
        {path: '/c-hub/ads-performance', label: 'Ads Performance'},
    ]},
];

export const CORE_PAGES: PageLink[] = [
    {path: '/revenue', label: 'Revenue'},
    {path: '/chatters', label: 'Chatters'},
    {path: '/creators', label: 'Creators'},
    {path: '/platforms', label: 'Platforms'},
];

export const REPORT_PAGES: PageLink[] = [
    {path: '/insights', label: 'Insights'},
    {path: '/revenue-tiers', label: 'Revenue Tiers'},
    {path: '/weekly-report', label: 'Weekly Report'},
    {path: '/monthly-report', label: 'Monthly Report'},
    {path: '/ask', label: 'Ask Your Data'},
];

export const HUB_PAGES: PageLink[] = [
    {path: '/compliance-dash', label: 'Compliance Dash'},
    {path: '/marketing', label: 'Marketing'},
    {path: '/models-socials', label: 'Models Socials'},
    {path: '/of-new-fan-growth', label: 'OF New Fan Growth'},
    {path: '/ads-performance', label: 'Ads Performance'},
    {path: '/notion-tickets', label: 'Notion Tickets'},
];

// Admin-only pages (never shareable with viewers).
export const ADMIN_PAGES: PageLink[] = [
    {path: '/data-sources', label: 'Data Sources'},
    {path: '/settings', label: 'Settings'},
    {path: '/edit-site', label: 'Edit Site'},
    {path: '/people-access', label: 'People Access'},
    {path: '/metric-definitions', label: 'Metric Definitions'},
    {path: '/inactivity-computation', label: 'Inactivity Computation'},
    {path: '/architecture', label: 'Architecture'},
];

// Admin pages reachable by link but not in the sidebar (Python app: in
// ADMIN_ROUTES but in no page group). /permission-groups is the old address
// of People Access.
export const HIDDEN_ADMIN_PAGES: PageLink[] = [
    {path: '/inactivity', label: 'Inactivity'},
    {path: '/transactions', label: 'Transactions'},
    {path: '/commissions', label: 'Commissions'},
    {path: '/permission-groups', label: 'People Access'},
];

// Pages open to every logged-in user.
export const ACCOUNT_PAGE: PageLink = {path: '/account', label: 'Account Settings'};

export const ALL_PAGES: PageLink[] = [
    WELCOME_PAGE,
    ...C_HUB_SECTIONS.flatMap(s => s.pages),
    ...CORE_PAGES,
    ...REPORT_PAGES,
    ...HUB_PAGES,
    ...ADMIN_PAGES,
    ...HIDDEN_ADMIN_PAGES,
    ACCOUNT_PAGE,
];

// Pages a viewer can be given (Python app: SHAREABLE_ROUTES). "*" means all of them.
export const SHAREABLE_PATHS = new Set([
    WELCOME_PAGE.path,
    ...C_HUB_SECTIONS.flatMap(s => s.pages.map(p => p.path)),
    ...CORE_PAGES.map(p => p.path),
    ...REPORT_PAGES.map(p => p.path),
    ...HUB_PAGES.map(p => p.path),
]);

export function pageTitle(path: string): string {
    return ALL_PAGES.find(p => p.path === path)?.label ?? 'Gaze';
}

export interface Viewer {
    role: 'admin' | 'viewer';
    allowedRoutes: string[];
}

export function canOpen(user: Viewer, path: string): boolean {
    if (user.role === 'admin') return true;
    if (path === WELCOME_PAGE.path || path === ACCOUNT_PAGE.path) return true;
    if (!SHAREABLE_PATHS.has(path)) return false;
    return user.allowedRoutes.includes('*') || user.allowedRoutes.includes(path);
}

// Sidebar groups for this user, in the Python app's order: C Hub, Core,
// Reports, Admin (admins only), then Hub. Empty groups are left out.
export function navGroupsFor(user: Viewer): NavGroup[] {
    const visible = (pages: PageLink[]) => pages.filter(p => canOpen(user, p.path));
    const groups: NavGroup[] = [
        {
            key: 'c-hub',
            label: 'C Hub',
            sections: C_HUB_SECTIONS.map(s => ({heading: s.heading, pages: visible(s.pages)})).filter(s => s.pages.length),
        },
        {key: 'core', label: 'Core', sections: [{heading: '', pages: visible(CORE_PAGES)}]},
        {key: 'reports', label: 'Reports', sections: [{heading: '', pages: visible(REPORT_PAGES)}]},
        {key: 'admin', label: 'Admin', sections: [{heading: '', pages: user.role === 'admin' ? ADMIN_PAGES : []}]},
        {key: 'looker', label: 'Hub', sections: [{heading: '', pages: visible(HUB_PAGES)}]},
    ];
    return groups.filter(g => g.sections.some(s => s.pages.length));
}
