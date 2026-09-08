/**
 * The ring is what makes a turn survive the viewer leaving. Everything the
 * daemon sends to a chat is ephemeral — the transcript backfill only replays
 * since the last prompt, and a turn whose completion push was suppressed (the
 * `quiet` dial suppresses every auto-push) has no other record anywhere. So the
 * ring's contract is not bookkeeping: it is the only reason a finished turn is
 * still on screen after a re-subscribe.
 */

import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

let TMP: string;
const originalState = process.env.XDG_STATE_HOME;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'zeph-turn-ring-'));
    process.env.XDG_STATE_HOME = TMP;
});
afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalState;
});

const {
    appendTurnRing,
    readTurnRing,
    sweepTurnRings,
    turnRingPath,
    turnRingDir,
    MAX_TURN_RING_BYTES,
    MAX_TURN_RING_FILES,
    TURN_RING_TTL_MS,
} = await import('./turn-ring.js');

const text = (body: string, at?: string) => ({ kind: 'text' as const, text: body, ...(at ? { at } : {}) });
const tool = (id: string) => ({ kind: 'tool' as const, id, name: 'Bash' });

/** Backdate a ring file so TTL and eviction can be exercised without waiting. */
const backdate = (sessionName: string, msAgo: number): void => {
    const when = new Date(Date.now() - msAgo);
    utimesSync(turnRingPath(sessionName), when, when);
};

describe('turn ring — what came back is what went in', () => {
    it('reads back the events it was given, in order, across separate appends', () => {
        appendTurnRing('zeph-app', [text('first'), tool('t1')]);
        appendTurnRing('zeph-app', [text('second')]);

        expect(readTurnRing('zeph-app')).toEqual([text('first'), tool('t1'), text('second')]);
    });

    it('reads nothing for a session it has never seen', () => {
        expect(readTurnRing('never-watched')).toEqual([]);
    });

    it('reads nothing from a ring file that exists but holds nothing', () => {
        appendTurnRing('zeph-app', [text('seed')]);
        writeFileSync(turnRingPath('zeph-app'), '');

        expect(readTurnRing('zeph-app')).toEqual([]);
    });

    it('writes no file at all for an empty batch', () => {
        appendTurnRing('zeph-app', []);

        expect(existsSync(turnRingPath('zeph-app'))).toBe(false);
    });

    it('keeps one session out of another session ring', () => {
        appendTurnRing('zeph-app', [text('mine')]);
        appendTurnRing('zeph-other', [text('theirs')]);

        expect(readTurnRing('zeph-app')).toEqual([text('mine')]);
    });
});

describe('turn ring — bounded', () => {
    it('drops the oldest events, not the newest, when the file passes its cap', () => {
        // Each line is well over 1KB, so a few hundred of them pass 256KB.
        const filler = 'x'.repeat(2000);
        for (let i = 0; i < 200; i++) appendTurnRing('zeph-app', [text(`${i}-${filler}`)]);

        const kept = readTurnRing('zeph-app');
        expect(statSync(turnRingPath('zeph-app')).size).toBeLessThanOrEqual(MAX_TURN_RING_BYTES);
        // The newest survived and the oldest did not — a ring that trimmed from
        // the wrong end would replay ancient work and lose what just happened.
        expect(kept.at(-1)).toEqual(text(`199-${filler}`));
        expect(kept.some((e) => 'text' in e && e.text.startsWith('0-'))).toBe(false);
    });

    it('keeps the newest line even when that one line is larger than the whole cap', () => {
        // Nothing the projection emits is this big — text clamps at 5000 chars —
        // but `appendTurnRing` takes any TurnEvent[], and taking zero lines here
        // would blank the ring and blank it again on every later append.
        appendTurnRing('zeph-app', [text('a'.repeat(MAX_TURN_RING_BYTES + 1000))]);

        expect(readTurnRing('zeph-app')).toHaveLength(1);
        appendTurnRing('zeph-app', [text('after')]);
        expect(readTurnRing('zeph-app').at(-1)).toEqual(text('after'));
    });

    it('stays under the cap even when a single batch is larger than the whole ring', () => {
        const huge = Array.from({ length: 200 }, (_, i) => text(`${i}-${'y'.repeat(3000)}`));

        appendTurnRing('zeph-app', huge);

        expect(statSync(turnRingPath('zeph-app')).size).toBeLessThanOrEqual(MAX_TURN_RING_BYTES);
        expect(readTurnRing('zeph-app').at(-1)).toEqual(huge.at(-1));
    });
});

describe('turn ring — damaged and expired files', () => {
    it('skips a line the daemon was killed halfway through writing', () => {
        appendTurnRing('zeph-app', [text('intact')]);
        // Appends go straight to the file (only the trim rewrite uses
        // tmp+rename), so a half-written last line is the realistic crash shape.
        writeFileSync(turnRingPath('zeph-app'), '{"kind":"text","tex', { flag: 'a' });

        expect(readTurnRing('zeph-app')).toEqual([text('intact')]);
    });

    it('skips a line that parsed but is not an event — null, a number, an array and a bare object are all valid JSON', () => {
        appendTurnRing('zeph-app', [text('intact')]);
        // Reachable through a hand-edited or planted file, not through a crash
        // (a torn line fails to parse). Slice 02 seals and sends whatever this
        // returns, so the shape check is the boundary.
        writeFileSync(turnRingPath('zeph-app'), 'null\n5\n"a string"\n[1,2]\n{}\n{"kind":7}\n', { flag: 'a' });

        expect(readTurnRing('zeph-app')).toEqual([text('intact')]);
    });

    it('deletes an expired ring instead of quietly appending onto it', () => {
        appendTurnRing('zeph-app', [text('ancient')]);
        backdate('zeph-app', TURN_RING_TTL_MS + 60_000);

        expect(readTurnRing('zeph-app')).toEqual([]);
        // The file has to be gone, not just unread: left in place, the next
        // append lands on top of pre-expiry content and the TTL means nothing.
        appendTurnRing('zeph-app', [text('fresh')]);
        expect(readTurnRing('zeph-app')).toEqual([text('fresh')]);
    });
});

describe('turn ring — sweep', () => {
    it('removes expired rings and keeps the newest ones when there are too many files', () => {
        for (let i = 0; i < MAX_TURN_RING_FILES + 5; i++) appendTurnRing(`session-${i}`, [text(`${i}`)]);
        // Oldest by mtime are the first five.
        for (let i = 0; i < 5; i++) backdate(`session-${i}`, 60_000 * (5 - i));
        appendTurnRing('expired', [text('gone')]);
        backdate('expired', TURN_RING_TTL_MS + 60_000);

        sweepTurnRings();

        expect(readdirSync(turnRingDir()).length).toBeLessThanOrEqual(MAX_TURN_RING_FILES);
        expect(readTurnRing('expired')).toEqual([]);
        // Both ends pinned: the oldest by mtime went and the newest stayed. Only
        // asserting the survivor would pass a sweep that dropped at random.
        expect(readTurnRing('session-0')).toEqual([]);
        expect(readTurnRing(`session-${MAX_TURN_RING_FILES + 4}`)).toEqual([text(`${MAX_TURN_RING_FILES + 4}`)]);
    });

    it('clears a temp file stranded by a kill during the trim rewrite', () => {
        appendTurnRing('zeph-app', [text('live')]);
        writeFileSync(`${turnRingPath('zeph-app')}.tmp`, 'half-written', { mode: 0o600 });

        sweepTurnRings();

        // Left alone nothing would ever remove it, and it would count against
        // MAX_TURN_RING_FILES — evicting a real session's ring one file early.
        expect(readdirSync(turnRingDir())).toHaveLength(1);
        expect(readdirSync(turnRingDir())[0]).toMatch(/\.jsonl$/);
        expect(readTurnRing('zeph-app')).toEqual([text('live')]);
    });

    it('does nothing when there is no ring directory yet', () => {
        sweepTurnRings();

        // Not just "did not throw": a sweep that started creating the directory
        // would put an empty dir on every machine that never opened a chat.
        expect(existsSync(turnRingDir())).toBe(false);
    });
});

describe('turn ring — the session name never reaches the filesystem', () => {
    it('keeps a name with path separators inside the ring directory', () => {
        appendTurnRing('../../etc/passwd', [text('nope')]);

        const files = readdirSync(turnRingDir());
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^[0-9a-f]{16}\.jsonl$/);
        expect(readTurnRing('../../etc/passwd')).toEqual([text('nope')]);
    });

    it('survives a session name that is not a string, because the name comes off the wire', () => {
        // `turn-watch.ts` only checks that sessionName is present. A number here
        // makes createHash throw, and every path in this module promises to cost
        // the scrollback rather than the tick that called it.
        expect(() => appendTurnRing(7 as unknown as string, [text('nope')])).not.toThrow();
        expect(readTurnRing(7 as unknown as string)).toEqual([]);
        expect(() => sweepTurnRings()).not.toThrow();
    });

    it('tightens permissions that already exist — mode only applies when the entry is created', () => {
        mkdirSync(turnRingDir(), { recursive: true, mode: 0o755 });
        chmodSync(turnRingDir(), 0o755);
        writeFileSync(turnRingPath('zeph-app'), '', { mode: 0o644 });
        chmodSync(turnRingPath('zeph-app'), 0o644);

        appendTurnRing('zeph-app', [text('private')]);

        // Pre-created by an installer, an older build, or another local account:
        // without the chmod the ring would sit world-readable forever, and the
        // modes are the only thing protecting a week of prompts and paths.
        expect(statSync(turnRingDir()).mode & 0o777).toBe(0o700);
        expect(statSync(turnRingPath('zeph-app')).mode & 0o777).toBe(0o600);
    });

    it('writes the ring readable only by its owner', () => {
        appendTurnRing('zeph-app', [text('private')]);

        // The projection strips file contents and command output, but a tool's
        // target is still a path on this machine.
        expect(statSync(turnRingPath('zeph-app')).mode & 0o777).toBe(0o600);
        expect(statSync(turnRingDir()).mode & 0o777).toBe(0o700);
    });
});
