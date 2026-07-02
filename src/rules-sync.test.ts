import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Belt-and-braces drift check: when a zeph-to/plugin checkout sits at the
// sibling ../plugin (the default dev layout), re-run the sync script in
// --check mode so local `npm test` catches generated-file drift without
// waiting for CI (which does the same against plugin main via a cross-repo
// checkout). Skipped on standalone clones.

const REPO_ROOT = join(__dirname, '..');
const PLUGIN_ROOT = join(REPO_ROOT, '..', 'plugin');
const hasPluginCheckout = existsSync(join(PLUGIN_ROOT, 'scripts', 'extract-core.js'));

describe.skipIf(!hasPluginCheckout)('rules-sync: generated artifacts match ../plugin', () => {
    it('sync-from-plugin --check passes', () => {
        expect(() =>
            execFileSync('node', [join(REPO_ROOT, 'scripts', 'sync-from-plugin.mjs'), '--check'], {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        ).not.toThrow();
    });
});

describe('rules-sync: generated core is wired into the templates', () => {
    it('hook-driven rules carry the shared core and the --auto notify command', async () => {
        const tmpl = await import('./templates.js');
        expect(tmpl.CURSOR_RULE).toContain('Sticky REMOTE mode');
        expect(tmpl.CURSOR_HOOKS).toContain('--auto');
    });

    it('rule-only rules carry the shared core too', async () => {
        const tmpl = await import('./templates.js');
        expect(tmpl.CLINE_RULE).toContain('Sticky REMOTE mode');
        expect(tmpl.AIDER_RULE).toContain('Sticky REMOTE mode');
    });
});
