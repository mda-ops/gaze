import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {api} from './client';

// The Account page's data (backend/src/routes/account.routes.ts).

export interface Profile {
    key: string;
    name: string;
    title: string;
    role: 'admin' | 'viewer';
    username: string;
    email: string;
    photoUrl: string;
}

export interface ProfileChanges {
    name: string;
    username: string;
    email: string;
    photoUrl: string;
    photo: {fileName: string; data: string} | null;
}

const ACCOUNT = ['account'];

export function useProfile() {
    return useQuery({queryKey: ACCOUNT, queryFn: async () => (await api<{profile: Profile}>('/api/account')).profile});
}

export function useSaveProfile() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (changes: ProfileChanges) => api<{saved: true}>('/api/account', {method: 'POST', body: changes}),
        onSuccess: async () => {
            await queryClient.invalidateQueries({queryKey: ACCOUNT});
            // The page frame shows the name and photo too.
            await queryClient.invalidateQueries({queryKey: ['auth', 'me']});
        },
    });
}

export function useChangePassword() {
    return useMutation({
        mutationFn: (body: {newPassword: string; confirmPassword: string}) =>
            api<{saved: true}>('/api/account/password', {method: 'POST', body}),
    });
}

// A chosen file as base64, for sending in JSON.
export function readFileBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}
