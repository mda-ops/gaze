import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    test: {
        environment: 'node',
        // Only the TypeScript sources; never the compiled dist/ copies.
        include: ['src/**/*.test.ts'],
    },
});
