import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
        environment: 'node',
        // Runs before every test file: sends $HOME and the XDG dirs to a
        // throwaway directory so no test can write into the developer's own
        // config, remote marker or session registry. See src/test-setup.ts —
        // this is not hygiene, it has already leaked.
        setupFiles: ['./src/test-setup.ts'],
        globals: false,
        // Each test file gets a fresh isolated module graph so module-level
        // state in src/crypto.ts (cachedKeyPair etc.) and src/cli.ts doesn't
        // leak across files.
        isolate: true,
    },
});
