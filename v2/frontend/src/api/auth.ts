import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {api, ApiError} from './client';

export interface User {
    key: string;
    name: string;
    title: string;
    role: 'admin' | 'viewer';
    username: string;
    photoUrl: string;
    allowedRoutes: string[];
}

const ME = ['auth', 'me'];

// The logged-in user, or null when nobody is logged in.
export function useCurrentUser() {
    return useQuery({
        queryKey: ME,
        queryFn: async () => {
            try {
                return (await api<{user: User}>('/api/auth/me')).user;
            } catch (e) {
                if (e instanceof ApiError && e.status === 401) return null;
                throw e;
            }
        },
        staleTime: 5 * 60 * 1000,
    });
}

export function useLogin() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (credentials: {username: string; password: string}) =>
            api<{user: User}>('/api/auth/login', {method: 'POST', body: credentials}),
        onSuccess: data => queryClient.setQueryData(ME, data.user),
    });
}

export function useLogout() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => api<void>('/api/auth/logout', {method: 'POST'}),
        onSuccess: () => {
            queryClient.clear();
            queryClient.setQueryData(ME, null);
        },
    });
}
