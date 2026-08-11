/**
 * Reading a session's changes from the phone.
 *
 * The wire carries a session NAME (and, for one file, its path). It never
 * carries a git command, a revision, or a repository path: the repo comes from
 * the registry this machine wrote while the session was alive, and the commands
 * are fixed. `git diff <ref>` parses a ref beginning with `-` as a flag, which
 * is why nothing caller-supplied reaches an argument position that git could
 * read as one.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

let gitCalls: string[][] = [];
/** What the fake git answers, per subcommand shape. */
let gitResponses: Record<string, { status: number; stdout: string; stderr?: string }> = {};

const gitKey = (args: readonly string[]): string => {
    // `-C <dir>` prefix is bookkeeping; key on the git verb that follows.
    const rest = args[0] === '-C' ? args.slice(2) : args;
    const verb = rest.filter((a) => a !== '--no-optional-locks')[0] ?? '';
    if (verb === 'diff' && rest.includes('--numstat')) return 'diff --numstat';
    if (verb === 'diff') return 'diff';
    if (verb === 'rev-parse') return 'rev-parse';
    if (verb === 'status') return 'status';
    return verb;
};

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawnSync: (cmd: string, args?: readonly string[]) => {
            const argv = args ?? [];
            if (cmd === 'git') {
                gitCalls.push([...argv]);
                return gitResponses[gitKey(argv)] ?? { status: 1, stdout: '', stderr: 'unexpected' };
            }
            if (cmd === 'tmux') return { status: 1, stdout: '', stderr: '' };
            return { status: 1, stdout: '', stderr: '' };
        },
    };
});

const TMP = mkdtempSync(join(tmpdir(), 'zeph-diff-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');
const REPO = join(TMP, 'work', 'api');
mkdirSync(join(REPO, 'src'), { recursive: true });
writeFileSync(join(REPO, 'src', 'index.ts'), 'export const a = 1;\n');
/** Somewhere outside the repo — the target of the traversal attempts. */
const OUTSIDE = join(TMP, 'secrets');
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(OUTSIDE, 'keys.txt'), 'super secret\n');

const { handleDiffFilesRequest, handleDiffFileRequest, computeListenerDeviceId, DIFF_PAGE_MAX_BYTES } =
    await import('./listener.js');
const { rememberSessions } = await import('./session-registry.js');

describe("agent.diff — what changed in a session's repo", () => {
    const device = computeListenerDeviceId();
    let sent: Array<Record<string, unknown>>;
    const send = (data: Record<string, unknown>) => { sent.push(data); };

    const filesRequest = (over: Record<string, unknown> = {}) => ({
        subtype: 'agent.diff.files.request',
        targetDeviceId: device,
        sessionName: 'zeph-api',
        requestId: 'r1',
        ...over,
    });

    const fileRequest = (over: Record<string, unknown> = {}) => ({
        subtype: 'agent.diff.file.request',
        targetDeviceId: device,
        sessionName: 'zeph-api',
        requestId: 'r1',
        path: 'src/index.ts',
        ...over,
    });

    const askFiles = (over: Record<string, unknown> = {}) => ({
        claimed: handleDiffFilesRequest(filesRequest(over), send),
        reply: sent.at(-1),
    });
    const askFile = (over: Record<string, unknown> = {}) => ({
        claimed: handleDiffFileRequest(fileRequest(over), send),
        reply: sent.at(-1),
    });

    const remember = (cwd = REPO) =>
        rememberSessions([{ name: 'zeph-api', cwd, agentKind: 'claude' }]);

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        gitCalls = [];
        sent = [];
        rmSync(join(TMP, 'state'), { recursive: true, force: true });
        gitResponses = {
            'rev-parse': { status: 0, stdout: `${REPO}\n` },
            status: { status: 0, stdout: ' M src/index.ts\n?? src/new.ts\n' },
            'diff --numstat': { status: 0, stdout: '4\t2\tsrc/index.ts\n' },
            diff: { status: 0, stdout: 'diff --git a/src/index.ts b/src/index.ts\n+added line\n' },
        };
    });
    afterEach(() => vi.restoreAllMocks());

    describe('routing', () => {
        it('does not claim other ephemeral traffic', () => {
            expect(handleDiffFilesRequest({ subtype: 'clipboard' }, send)).toBe(false);
            expect(handleDiffFileRequest({ subtype: 'agent.diff.files.request' }, send)).toBe(false);
            expect(sent).toEqual([]);
        });

        it('ignores a request addressed to another machine', () => {
            remember();
            expect(askFiles({ targetDeviceId: 'dev_other' }).claimed).toBe(false);
            expect(gitCalls).toEqual([]);
        });

        // The registry is the only source of a repository path. A session this
        // machine never ran has none, and there is nothing else to fall back to.
        it('refuses a session it has no record of', () => {
            remember();
            expect(askFiles({ sessionName: 'zeph-elsewhere' }).reply?.error).toBe('unknown_session');
            expect(gitCalls).toEqual([]);
        });

        it('says so when the session directory is not a repository', () => {
            remember();
            gitResponses['rev-parse'] = { status: 128, stdout: '', stderr: 'not a git repository' };

            expect(askFiles().reply?.error).toBe('not_a_repo');
        });
    });

    describe('the file list', () => {
        it('answers with the changed files and their line counts', () => {
            remember();

            const { reply } = askFiles();

            expect(reply).toMatchObject({
                subtype: 'agent.diff.files.result',
                requestId: 'r1',
                sessionName: 'zeph-api',
            });
            expect(reply?.files).toEqual([
                { path: 'src/index.ts', status: 'M', added: 4, removed: 2 },
                { path: 'src/new.ts', status: '?', added: 0, removed: 0 },
            ]);
        });

        // Every argument is fixed. Nothing from the request reaches argv here,
        // which is what makes `-`-prefixed input a non-issue for this command.
        it('runs a fixed read-only command set inside the recorded repo', () => {
            remember();

            askFiles();

            for (const call of gitCalls) {
                expect(call[0]).toBe('-C');
                expect(call[1]).toBe(REPO);
                expect(call).not.toContain('commit');
                expect(call).not.toContain('checkout');
                expect(call).not.toContain('add');
            }
            expect(gitCalls.some((c) => c.includes('status'))).toBe(true);
            expect(gitCalls.some((c) => c.includes('--numstat'))).toBe(true);
        });
    });

    describe('one file', () => {
        it("answers with that file's patch", () => {
            remember();

            const { reply } = askFile();

            expect(reply).toMatchObject({
                subtype: 'agent.diff.file.result',
                path: 'src/index.ts',
                hasMore: false,
            });
            expect(String(reply?.chunk)).toContain('+added line');
        });

        // `--` is what stops a path that looks like a flag from being read as
        // one, and the path is passed as its own argv entry either way.
        it('passes the path after a -- separator', () => {
            remember();

            askFile();

            const diff = gitCalls.find((c) => c.includes('diff')) as string[];
            const sep = diff.indexOf('--');
            expect(sep).toBeGreaterThan(0);
            expect(diff.slice(sep + 1)).toEqual(['src/index.ts']);
        });

        it('refuses a path that climbs out of the repository', () => {
            remember();

            const { reply } = askFile({ path: '../../secrets/keys.txt' });

            expect(reply?.error).toBe('path_outside_repo');
            expect(gitCalls.some((c) => c.includes('diff'))).toBe(false);
        });

        it('refuses an absolute path', () => {
            remember();

            expect(askFile({ path: join(OUTSIDE, 'keys.txt') }).reply?.error).toBe('path_outside_repo');
        });

        // resolve() alone would accept this: the string stays inside the repo
        // and only the filesystem knows it leaves.
        it('refuses a symlink that points outside the repository', () => {
            remember();
            const link = join(REPO, 'escape.txt');
            rmSync(link, { force: true });
            symlinkSync(join(OUTSIDE, 'keys.txt'), link);

            expect(askFile({ path: 'escape.txt' }).reply?.error).toBe('path_outside_repo');
        });

        it('refuses a path that is not a string', () => {
            remember();
            expect(askFile({ path: 42 }).reply?.error).toBe('bad_path');
            expect(askFile({ path: '' }).reply?.error).toBe('bad_path');
        });
    });

    describe('paging a large patch', () => {
        const huge = () => 'x'.repeat(DIFF_PAGE_MAX_BYTES * 2) + '\n';

        it('cuts the page at the transport limit and says there is more', () => {
            remember();
            gitResponses.diff = { status: 0, stdout: huge() };

            const { reply } = askFile();

            expect(Buffer.byteLength(String(reply?.chunk), 'utf-8')).toBeLessThanOrEqual(DIFF_PAGE_MAX_BYTES);
            expect(reply?.hasMore).toBe(true);
            expect(reply?.offset).toBe(0);
        });

        it('continues from the offset the caller reports', () => {
            remember();
            gitResponses.diff = { status: 0, stdout: huge() };

            const first = askFile().reply;
            const nextOffset = Number(first?.offset) + Number(first?.length);
            const { reply } = askFile({ offset: nextOffset });

            expect(reply?.offset).toBe(nextOffset);
            expect(String(reply?.chunk).length).toBeGreaterThan(0);
        });

        it('refuses an offset that is not a whole non-negative number', () => {
            remember();
            for (const bad of [-1, 1.5, NaN, '10']) {
                expect(askFile({ offset: bad }).reply?.error).toBe('bad_range');
            }
        });
    });

    /**
     * A diff is the same class of content as pane text: the user who turned
     * E2EE on must not lose it by reading their changes instead of their
     * terminal. There is no stream here to borrow a key from, so the request
     * carries one — the same posture the frames have (strong against a passive
     * relay, not against an active one), not a new hole.
     */
    describe('sealing', () => {
        const recipientKey = async (): Promise<string> => {
            const { webcrypto } = await import('node:crypto');
            const wc = webcrypto as unknown as Crypto;
            const pair = (await wc.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'],
            )) as CryptoKeyPair;
            const spki = new Uint8Array(await wc.subtle.exportKey('spki', pair.publicKey));
            let bin = '';
            for (let i = 0; i < spki.length; i++) bin += String.fromCharCode(spki[i]);
            return btoa(bin);
        };

        const settle = async () => {
            for (let i = 0; i < 50 && sent.length === 0; i++) {
                await new Promise((r) => setTimeout(r, 1));
            }
        };

        it('seals the file list for the caller that asked with a key', async () => {
            const { initDeviceCrypto } = await import('./crypto.js');
            await initDeviceCrypto();
            remember();

            handleDiffFilesRequest(filesRequest({ subscriberPublicKey: await recipientKey() }), send);
            await settle();

            const reply = sent.at(-1);
            expect(reply?.files).toBeUndefined();
            expect(reply?.encrypted).toBeDefined();
            expect((reply?.encrypted as { ciphertext: string }).ciphertext).not.toContain('index.ts');
        });

        it('seals a file patch the same way', async () => {
            const { initDeviceCrypto } = await import('./crypto.js');
            await initDeviceCrypto();
            remember();

            handleDiffFileRequest(fileRequest({ subscriberPublicKey: await recipientKey() }), send);
            await settle();

            const reply = sent.at(-1);
            expect(reply?.chunk).toBeUndefined();
            expect(reply?.encrypted).toBeDefined();
            // Paging metadata still rides in the clear, like the frames' own.
            expect(reply?.offset).toBe(0);
        });

        it('reports a failed seal rather than answering in the clear', async () => {
            remember();

            handleDiffFilesRequest(filesRequest({ subscriberPublicKey: 'not-a-key' }), send);
            await settle();

            const reply = sent.at(-1);
            expect(reply?.error).toBe('encrypt_failed');
            expect(reply?.files).toBeUndefined();
            expect(reply?.encrypted).toBeUndefined();
        });
    });
});
