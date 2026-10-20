import {describe, expect, it} from 'vitest';
import {canOpen, navGroupsFor} from './pages';

describe('canOpen', () => {
    const viewer = {role: 'viewer' as const, allowedRoutes: ['/c-hub/revenue']};

    it('lets a viewer open only allowed pages, plus Welcome and Account', () => {
        expect(canOpen(viewer, '/c-hub/revenue')).toBe(true);
        expect(canOpen(viewer, '/c-hub/commissions')).toBe(false);
        expect(canOpen(viewer, '/')).toBe(true);
        expect(canOpen(viewer, '/account')).toBe(true);
    });

    it('never shows admin pages to viewers, even with *', () => {
        expect(canOpen({role: 'viewer', allowedRoutes: ['*']}, '/settings')).toBe(false);
        expect(canOpen({role: 'admin', allowedRoutes: []}, '/settings')).toBe(true);
    });

    it('never shares the hidden Core pages with viewers, as in the Python app', () => {
        for (const path of ['/inactivity', '/transactions', '/commissions', '/permission-groups']) {
            expect(canOpen({role: 'viewer', allowedRoutes: ['*', path]}, path)).toBe(false);
            expect(canOpen({role: 'admin', allowedRoutes: []}, path)).toBe(true);
        }
        expect(canOpen({role: 'viewer', allowedRoutes: ['*']}, '/c-hub/transactions')).toBe(true);
    });
});

describe('navGroupsFor', () => {
    it('shows a viewer only groups with visible pages', () => {
        const groups = navGroupsFor({role: 'viewer', allowedRoutes: ['/c-hub/revenue', '/marketing']});
        expect(groups.map(g => g.key)).toEqual(['c-hub', 'looker']);
        expect(groups[0].sections).toEqual([{heading: 'Chat Dept', pages: [{path: '/c-hub/revenue', label: 'Model Revenue Overview'}]}]);
    });

    it('shows admins every group in the Python app order', () => {
        expect(navGroupsFor({role: 'admin', allowedRoutes: ['*']}).map(g => g.key)).toEqual(['c-hub', 'core', 'reports', 'admin', 'looker']);
    });
});
