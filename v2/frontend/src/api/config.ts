import {useQuery} from '@tanstack/react-query';
import {api} from './client';

export interface AppConfig {
    // Business date in the settings time zone.
    today: string;
    reportingWeekStart: string;
    defaultCurrency: string;
}

export function useConfig() {
    return useQuery({queryKey: ['config'], queryFn: () => api<AppConfig>('/api/config'), staleTime: 10 * 60 * 1000});
}
