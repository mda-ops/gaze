import type {ReactNode} from 'react';
import {Navigate, Route, Routes, useLocation} from 'react-router-dom';
import {useCurrentUser, type User} from './api/auth';
import {AppShell} from './components/AppShell';
import {LoginPage} from './pages/LoginPage';
import {WelcomePage} from './pages/WelcomePage';
import {ExecutiveOverviewPage} from './pages/ExecutiveOverviewPage';
import {ModelRevenuePage} from './pages/ModelRevenuePage';
import {ChatterRevenuePage} from './pages/ChatterRevenuePage';
import {TransactionsPage} from './pages/TransactionsPage';
import {InactivityPage} from './pages/InactivityPage';
import {CommissionsPage} from './pages/CommissionsPage';
import {TargetMonitoringPage} from './pages/TargetMonitoringPage';
import {ChatterRevenueTierPage} from './pages/ChatterRevenueTierPage';
import {ChattersPage, CreatorsPage, PlatformsPage, RevenuePage} from './pages/CoreAnalysisPages';
import {AccountPage} from './pages/AccountPage';
import {AskPage} from './pages/AskPage';
import {InsightsPage} from './pages/InsightsPage';
import {ArchitecturePage, InactivityComputationPage, MetricDefinitionsPage} from './pages/InfoPages';
import {EditSitePage} from './pages/EditSitePage';
import {DataSourcesPage, SettingsPage} from './pages/AdminSettingsPages';
import {
    AdsPerformancePage, CHubAdsPerformancePage, CHubOverviewPage, CHubCompliancePage, CHubMarketingAdsPage, CHubModelsSocialsPage, CHubOfNewFansPage, CHubTicketsPage,
    ComplianceDashPage, MarketingPage, ModelsSocialsPage, NotionTicketsPage, OfNewFanGrowthPage,
} from './pages/LookerPages';
import {PeopleAccessPage} from './pages/PeopleAccessPage';
import {MonthlyReportPage, WeeklyReportPage} from './pages/ReportPages';
import {PerformanceHubPage} from './pages/PerformanceHubPage';
import {RevenueTiersPage} from './pages/RevenueTiersPage';
import {PerformanceHub2Page} from './pages/PerformanceHub2Page';
import {ALL_PAGES, canOpen, pageTitle} from './pages';

// Page components by path.
const PAGES: Record<string, (props: {user: User}) => ReactNode> = {
    '/': WelcomePage,
    '/c-hub/executive-overview': ExecutiveOverviewPage,
    '/c-hub/revenue': ModelRevenuePage,
    '/c-hub/chatter-revenue': ChatterRevenuePage,
    '/c-hub/transactions': TransactionsPage,
    '/transactions': TransactionsPage,
    '/c-hub/inactivity': InactivityPage,
    '/inactivity': InactivityPage,
    '/c-hub/commissions': CommissionsPage,
    '/commissions': CommissionsPage,
    '/c-hub/target-monitoring': TargetMonitoringPage,
    '/c-hub/chatter-revenue-tier': ChatterRevenueTierPage,
    '/c-hub/performance': PerformanceHubPage,
    '/revenue': RevenuePage,
    '/chatters': ChattersPage,
    '/creators': CreatorsPage,
    '/platforms': PlatformsPage,
    '/insights': InsightsPage,
    '/ask': AskPage,
    '/revenue-tiers': RevenueTiersPage,
    '/metric-definitions': MetricDefinitionsPage,
    '/inactivity-computation': InactivityComputationPage,
    '/architecture': ArchitecturePage,
    '/account': AccountPage,
    '/people-access': PeopleAccessPage,
    '/edit-site': EditSitePage,
    '/settings': SettingsPage,
    '/data-sources': DataSourcesPage,
    '/compliance-dash': ComplianceDashPage,
    '/marketing': MarketingPage,
    '/models-socials': ModelsSocialsPage,
    '/of-new-fan-growth': OfNewFanGrowthPage,
    '/ads-performance': AdsPerformancePage,
    '/notion-tickets': NotionTicketsPage,
    '/c-hub/compliance': CHubCompliancePage,
    '/c-hub/marketing-ads': CHubMarketingAdsPage,
    '/c-hub/models-socials': CHubModelsSocialsPage,
    '/c-hub/of-new-fans': CHubOfNewFansPage,
    '/c-hub/ads-performance': CHubAdsPerformancePage,
    '/c-hub/tickets': CHubTicketsPage,
    '/c-hub': CHubOverviewPage,
    '/weekly-report': WeeklyReportPage,
    '/monthly-report': MonthlyReportPage,
    '/permission-groups': PeopleAccessPage,
    '/c-hub/performance-2': PerformanceHub2Page,
};

function Page({user}: {user: User}) {
    const {pathname} = useLocation();
    const path = pathname.replace(/\/$/, '') || '/';
    const known = Object.hasOwn(PAGES, path) && ALL_PAGES.some(p => p.path === path);
    // Unknown and forbidden pages look the same, as in the Python app.
    if (!known || !canOpen(user, path)) {
        return (
            <AppShell user={user} title="Not found" currentPath={path} showBlocks={false}>
                <section className="panel"><h2>Not found</h2><p className="note">This page does not exist or is not shared with you.</p></section>
            </AppShell>
        );
    }
    const Component = PAGES[path];
    return (
        <AppShell user={user} title={path === '/' ? 'Welcome to GAZE' : pageTitle(path)} currentPath={path}>
            <Component user={user}/>
        </AppShell>
    );
}

export function App() {
    const {data: user, isLoading, error} = useCurrentUser();
    if (isLoading) return null;
    if (error) return <main><section className="panel"><h2>Gaze is unavailable</h2><p className="note">{error.message}</p></section></main>;

    return (
        <Routes>
            <Route path="/login" element={user ? <Navigate to="/" replace/> : <LoginPage/>}/>
            <Route path="*" element={user ? <Page user={user}/> : <Navigate to="/login" replace/>}/>
        </Routes>
    );
}
