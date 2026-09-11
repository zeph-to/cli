import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, afterEach } from 'vitest';

/**
 * Point `stateDir()` at a throwaway directory for the length of one suite.
 *
 * Both files that keep state under `stateDir()` need this and both had rolled
 * it by hand, restore-else-delete included. Modules that read the env at call
 * time (`gate.ts`'s `stateDir`) can be imported normally; only ones that freeze
 * a path at module scope need the dynamic-import dance.
 */
export const withTmpStateDir = (prefix: string): (() => string) => {
    let dir = '';
    const original = process.env.XDG_STATE_HOME;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), prefix));
        process.env.XDG_STATE_HOME = dir;
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        if (original === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = original;
    });
    return () => dir;
};
