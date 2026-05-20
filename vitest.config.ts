import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
        environment: 'node',
        globals: false,
        // Each test file gets a fresh isolated module graph so module-level
        // state in src/crypto.ts (cachedKeyPair etc.) and src/cli.ts doesn't
        // leak across files.
        isolate: true,
    },
});
