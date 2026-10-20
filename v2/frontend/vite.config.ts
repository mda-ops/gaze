import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        // `npm run dev` here + `npm run serve` in v2/: API calls go to the backend.
        proxy: {'/api': 'http://127.0.0.1:8767'},
    },
});
