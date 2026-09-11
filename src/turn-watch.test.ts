import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    createTurnWatchers,
    MAX_TURN_SEAL_FAILURES,
    MAX_TURN_WATCHERS,
    TRANSCRIPT_RECHECK_MS,
    TURN_LEASE_MS,
    MAX_REPLAY_EVENTS,
    MAX_TURN_FRAME_BYTES,
    type TurnWatchDeps,
} from './turn-watch.js';
import type { TurnEvent } from './transcript-tail.js';
import type { TurnRing } from './turn-ring.js';

const DEVICE = 'dev_listener_abc123';

let dir: string;
let sent: Record<string, unknown>[];
let logs: string[];
let clock: number;
let ring: Map<string, TurnEvent[]>;
let sweeps: number;

/** Real transcripts stamp every entry; the cut against the ring reads that stamp. */
let stamp = 0;
const at = () => new Date(Date.UTC(2026, 8, 8, 0, 0, ++stamp)).toISOString();

const line = (obj: Record<string, unknown>) => `${JSON.stringify({ timestamp: at(), ...obj })}\n`;
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const userPrompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } });

/** In-memory stand-in for the disk ring — slice 01 owns the file behaviour. */
const makeRing = (): TurnRing => ({
    read: (session) => [...(ring.get(session) ?? [])],
    append: (session, events) => {
        ring.set(session, [...(ring.get(session) ?? []), ...events]);
        return true;
    },
    sweep: () => {
        sweeps++;
    },
});

const transcriptFor = (session: string) => join(dir, `${session}.jsonl`);

const makeDeps = (over: Partial<TurnWatchDeps> = {}): TurnWatchDeps => ({
    deviceId: () => DEVICE,
    resolveTranscript: (session) => transcriptFor(session),
    sessionExists: () => true,
    initCrypto: async () => {},
    seal: async (plaintext) => ({ ciphertext: `sealed:${plaintext.length}` }),
    log: (m) => logs.push(m),
    now: () => clock,
    ring: makeRing(),
    ...over,
});

const send = (data: Record<string, unknown>) => {
    sent.push(data);
};

const start = (session: string, extra: Record<string, unknown> = {}) => ({
    subtype: 'agent.turn.watch.start',
    targetDeviceId: DEVICE,
    sessionName: session,
    ...extra,
});

const deltas = () => sent.filter((f) => f.subtype === 'agent.turn.delta');

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zeph-turn-'));
    sent = [];
    logs = [];
    clock = 1_000_000;
    ring = new Map();
    sweeps = 0;
    stamp = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('turn watch control', () => {
    it('ignores control messages addressed to another machine', () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('hi'));

        const handled = watchers.handle({ ...start('s1'), targetDeviceId: 'dev_listener_other' }, send);

        expect(handled).toBe(false);
        expect(watchers.size()).toBe(0);
    });

    it('ignores messages that are not watch control at all', () => {
        const watchers = createTurnWatchers(makeDeps());
        expect(watchers.handle({ subtype: 'agent.stream.start', targetDeviceId: DEVICE, sessionName: 's1' }, send)).toBe(false);
    });

    it('refuses a session with no Claude transcript instead of showing an empty timeline', () => {
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: () => null }));

        watchers.handle(start('codex-session'), send);

        expect(sent).toEqual([
            { subtype: 'agent.turn.watch.error', sessionName: 'codex-session', error: 'no_transcript' },
        ]);
        expect(watchers.size()).toBe(0);
    });

    it('refuses past MAX_TURN_WATCHERS', () => {
        const watchers = createTurnWatchers(makeDeps());
        for (let i = 0; i < MAX_TURN_WATCHERS + 1; i++) {
            writeFileSync(transcriptFor(`s${i}`), userPrompt('hi'));
            watchers.handle(start(`s${i}`), send);
        }

        expect(watchers.size()).toBe(MAX_TURN_WATCHERS);
        expect(sent.at(-1)).toMatchObject({ error: 'watch_limit' });
    });

    it('answers a renew for a watch that no longer exists', () => {
        const watchers = createTurnWatchers(makeDeps());

        watchers.handle({ subtype: 'agent.turn.watch.renew', targetDeviceId: DEVICE, sessionName: 's1' }, send);

        expect(sent).toEqual([{ subtype: 'agent.turn.watch.gone', sessionName: 's1' }]);
    });
});

describe('turn watch streaming', () => {
    it('backfills only the in-flight turn, so finished turns stay the pushes they already are', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(
            transcriptFor('s1'),
            userPrompt('old turn') + toolUse('t1', 'Read', { file_path: '/old.ts' }) + userPrompt('current') + toolUse('t2', 'Read', { file_path: '/new.ts' }),
        );

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        const events = deltas().flatMap((f) => f.events as unknown[]);
        expect(JSON.stringify(events)).not.toContain('/old.ts');
        expect(JSON.stringify(events)).toContain('/new.ts');
    });

    it('emits new tool calls as they are appended', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const before = deltas().length;

        appendFileSync(transcriptFor('s1'), toolUse('t9', 'Bash', { description: 'Run the tests' }));
        await watchers.tick('s1');

        const latest = deltas().at(-1)!;
        expect(deltas().length).toBeGreaterThan(before);
        // `at` comes from the entry's own `timestamp`, which every real
        // transcript carries and the cut against the ring reads.
        expect(latest.events).toEqual([
            { kind: 'tool', id: 't9', name: 'Bash', target: 'Run the tests', at: expect.any(String) },
        ]);
        expect(latest.seq).toBe(deltas().length);
    });

    it('sends nothing when the transcript did not move', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const before = deltas().length;

        await watchers.tick('s1');
        await watchers.tick('s1');

        expect(deltas().length).toBe(before);
    });

    it('seals the batch when the subscriber supplied a key, and never sends the plaintext beside it', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/secret/path.ts' }));

        watchers.handle(start('s1', { subscriberPublicKey: 'viewer-key' }), send);
        await watchers.tick('s1');

        const frame = deltas().at(-1)!;
        expect(frame.encrypted).toBeDefined();
        expect(frame.events).toBeUndefined();
        expect(JSON.stringify(frame)).not.toContain('/secret/path.ts');
    });

    it('drops the batch rather than downgrading to plaintext when sealing fails', async () => {
        const watchers = createTurnWatchers(
            makeDeps({
                seal: async () => {
                    throw new Error('no device key');
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/secret/path.ts' }));

        watchers.handle(start('s1', { subscriberPublicKey: 'viewer-key' }), send);
        await watchers.tick('s1');

        expect(deltas()).toHaveLength(0);
        expect(JSON.stringify(sent)).not.toContain('/secret/path.ts');
        expect(logs.some((l) => l.includes('seal failed'))).toBe(true);
    });

    it('sends in the clear for a device with no keypair — the timeline is not a paid feature', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/a.ts' }));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        expect(deltas().at(-1)!.events).toBeDefined();
    });
});

describe('turn watch release', () => {
    it('stops on watch.stop', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);

        watchers.handle({ subtype: 'agent.turn.watch.stop', targetDeviceId: DEVICE, sessionName: 's1' }, send);

        expect(watchers.size()).toBe(0);
    });

    it('stops on lease expiry even when watch.stop never arrives', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        expect(watchers.size()).toBe(1);

        clock += TURN_LEASE_MS + 1;
        await watchers.tick('s1');

        expect(watchers.size()).toBe(0);
        expect(logs.some((l) => l.includes('lease expired'))).toBe(true);
    });

    it('keeps the watch alive while renews keep arriving', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);

        for (let i = 0; i < 3; i++) {
            clock += TURN_LEASE_MS - 1_000;
            watchers.handle({ subtype: 'agent.turn.watch.renew', targetDeviceId: DEVICE, sessionName: 's1' }, send);
            await watchers.tick('s1');
        }

        expect(watchers.size()).toBe(1);
    });

    it('releases every watcher when the socket goes — a reconnect must not leave orphans', () => {
        const watchers = createTurnWatchers(makeDeps());
        for (let i = 0; i < MAX_TURN_WATCHERS; i++) {
            writeFileSync(transcriptFor(`s${i}`), userPrompt('go'));
            watchers.handle(start(`s${i}`), send);
        }
        expect(watchers.size()).toBe(MAX_TURN_WATCHERS);

        watchers.stopAll('socket closed');

        expect(watchers.size()).toBe(0);
    });

    it('a tick after stop neither sends nor revives the watcher', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        watchers.stop('s1', 'test');
        const before = sent.length;

        appendFileSync(transcriptFor('s1'), toolUse('t2', 'Read'));
        await watchers.tick('s1');

        expect(sent).toHaveLength(before);
        expect(watchers.size()).toBe(0);
    });
});

describe('turn watch regressions', () => {
    it('gives up and says so after repeated seal failures, instead of an endless silent drop', async () => {
        const watchers = createTurnWatchers(
            makeDeps({
                seal: async () => {
                    throw new Error('no device key');
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1', { subscriberPublicKey: 'viewer-key' }), send);

        for (let i = 0; i < MAX_TURN_SEAL_FAILURES; i++) {
            appendFileSync(transcriptFor('s1'), toolUse(`t${i}`, 'Read'));
            await watchers.tick('s1');
        }

        expect(sent.at(-1)).toMatchObject({ subtype: 'agent.turn.watch.error', error: 'seal_failed' });
        expect(watchers.size()).toBe(0);
    });

    it('a repeated start re-states the key, so a keyless viewer cannot pin the session to plaintext', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        watchers.handle(start('s1', { subscriberPublicKey: 'viewer-key' }), send);
        appendFileSync(transcriptFor('s1'), toolUse('t2', 'Read', { file_path: '/secret.ts' }));
        await watchers.tick('s1');

        const latest = deltas().at(-1)!;
        expect(latest.encrypted).toBeDefined();
        expect(JSON.stringify(latest)).not.toContain('/secret.ts');
    });

    it('bumps the epoch and restarts seq on a repeated start, so the viewer does not discard the new batches', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const first = deltas().at(-1)!;

        watchers.handle(start('s1'), send);
        await Promise.resolve();
        const second = deltas().at(-1)!;

        expect(second.epoch).toBe((first.epoch as number) + 1);
        expect(second.seq).toBe(1);
    });

    it('backfills again on a repeated start — reopening the chat inside the lease must not show a blank turn', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/live.ts' }));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const before = deltas().length;

        // The viewer left without its `stop` landing and came back inside the
        // lease: the watcher is still registered and already at EOF, so without a
        // re-seed the new viewer would see nothing until the next tool call.
        watchers.handle(start('s1'), send);
        await Promise.resolve();

        expect(deltas().length).toBeGreaterThan(before);
        expect(JSON.stringify(deltas().at(-1)!.events)).toContain('/live.ts');
    });

    it('leaves no orphan poll chain behind when a start re-seeds a live watcher', async () => {
        const armed = new Set<unknown>();
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        // Count live timers directly: an orphan is invisible in `watchers`, and
        // only shows up as a session polled twice per interval.
        globalThis.setTimeout = ((fn: () => void, ms?: number) => {
            const handle = realSetTimeout(fn, ms);
            armed.add(handle);
            return handle;
        }) as typeof globalThis.setTimeout;
        globalThis.clearTimeout = ((handle: Parameters<typeof globalThis.clearTimeout>[0]) => {
            armed.delete(handle);
            realClearTimeout(handle);
        }) as typeof globalThis.clearTimeout;

        try {
            const watchers = createTurnWatchers(makeDeps());
            writeFileSync(transcriptFor('s1'), userPrompt('go'));
            watchers.handle(start('s1'), send);
            const afterFirst = 1;

            // Drain the immediate read each start kicks off, without the drain
            // itself registering in `armed`.
            const settle = () => new Promise((r) => realSetTimeout(r, 0));
            await settle();

            for (let i = 0; i < 3; i++) {
                watchers.handle(start('s1'), send);
                await settle();
            }

            expect(armed.size).toBe(afterFirst);
            watchers.stopAll('test');
            await settle();
            expect(armed.size).toBe(0);
        } finally {
            globalThis.setTimeout = realSetTimeout;
            globalThis.clearTimeout = realClearTimeout;
        }
    });

    it('stops when tmux no longer holds the session', async () => {
        let alive = true;
        const watchers = createTurnWatchers(makeDeps({ sessionExists: () => alive }));
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        expect(watchers.size()).toBe(1);

        alive = false;
        await watchers.tick('s1');

        expect(watchers.size()).toBe(0);
        expect(logs.some((l) => l.includes('tmux session gone'))).toBe(true);
    });

    it('refuses to watch at all when a seal was asked for and the keypair will not load', async () => {
        const watchers = createTurnWatchers(
            makeDeps({
                initCrypto: async () => {
                    throw new Error('keychain locked');
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read'));

        watchers.handle(start('s1', { subscriberPublicKey: 'viewer-key' }), send);
        await new Promise((r) => setTimeout(r, 0));

        expect(sent.at(-1)).toMatchObject({ subtype: 'agent.turn.watch.error', error: 'e2ee_unavailable' });
        expect(watchers.size()).toBe(0);
        expect(deltas()).toHaveLength(0);
    });
});

describe('turn watch follows the session', () => {
    it('moves to the new transcript when the session starts writing elsewhere', async () => {
        // `/clear` writes a file under a new name; the old one just stops growing,
        // so a watcher pinned to it goes quiet and looks like an idle agent.
        let target = 'before-clear';
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: () => transcriptFor(target) }));
        writeFileSync(transcriptFor('before-clear'), userPrompt('old session'));
        writeFileSync(transcriptFor('after-clear'), userPrompt('new session') + toolUse('t9', 'Read', { file_path: '/after.ts' }));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const before = deltas().length;

        target = 'after-clear';
        clock += TRANSCRIPT_RECHECK_MS;
        await watchers.tick('s1');

        expect(deltas().length).toBeGreaterThan(before);
        expect(JSON.stringify(deltas().at(-1)!.events)).toContain('/after.ts');
        expect(logs.some((l) => l.includes('transcript rotated'))).toBe(true);
    });

    it('does not re-resolve on every tick — the session registry is not free', async () => {
        let calls = 0;
        const watchers = createTurnWatchers(
            makeDeps({
                resolveTranscript: (session) => {
                    calls += 1;
                    return transcriptFor(session);
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go'));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const afterStart = calls;

        for (let i = 0; i < 5; i++) await watchers.tick('s1');

        expect(calls).toBe(afterStart);
    });
});

describe('turn watch — the scrollback the ring keeps', () => {
    /** Every event the viewer has been handed, sealed frames included. */
    const received = () => deltas().flatMap((f) => (f.events as TurnEvent[] | undefined) ?? []);

    it('replays the earlier turn when the chat comes back, even though no push ever recorded it', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('first ask') + toolUse('t1', 'Read', { file_path: '/first.ts' }));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        // The turn ends and a new one begins, so the backfill's own window would
        // now start at the second prompt and the first turn would be lost.
        appendFileSync(transcriptFor('s1'), userPrompt('second ask'));
        await watchers.tick('s1');
        watchers.handle({ subtype: 'agent.turn.watch.stop', targetDeviceId: DEVICE, sessionName: 's1' }, send);
        sent = [];

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        expect(JSON.stringify(received())).toContain('/first.ts');
        expect(JSON.stringify(received())).toContain('first ask');
    });

    it('says nothing at all when the ring writes fine', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', {}));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        // The complaint below is once-per-watch, so a fake that reported failure
        // by accident would leave every other case in this file exercising the
        // failure branch and nothing exercising this one.
        expect(logs.filter((l) => l.includes('ring write failed'))).toHaveLength(0);
        expect(ring.get('s1')!.length).toBeGreaterThan(0);
    });

    it('does not write the replay back into the ring', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/a.ts' }));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        const afterFirst = ring.get('s1')!.length;

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        // A replay that appended would double the ring on every re-open, and the
        // doubling would compound.
        expect(ring.get('s1')!.length).toBe(afterFirst);
    });

    it('cuts the backfill down to what the ring has not already sent', async () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/a.ts' }));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        appendFileSync(transcriptFor('s1'), toolUse('t2', 'Read', { file_path: '/b.ts' }));
        sent = [];

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        const ids = received().filter((e) => e.kind === 'tool').map((e) => (e as { id: string }).id);
        // t1 arrives once — from the replay — and not a second time from the
        // backfill that re-reads the same region of the transcript.
        expect(ids.filter((id) => id === 't1')).toHaveLength(1);
        expect(ids).toContain('t2');
    });

    it('keeps a backfilled event that carries no timestamp rather than guessing it was sent', async () => {
        const watchers = createTurnWatchers(makeDeps());
        // A transcript entry with no `timestamp` projects an event with no `at`,
        // and the cut has nothing to compare — dropping it would lose a turn.
        writeFileSync(
            transcriptFor('s1'),
            `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n` +
                `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'nostamp', name: 'Read', input: {} }] } })}\n`,
        );
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        sent = [];

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        expect(received().some((e) => e.kind === 'tool' && (e as { id: string }).id === 'nostamp')).toBe(true);
    });

    it('replays nothing when the session starts writing a different transcript', async () => {
        let target = 'before-clear';
        const watchers = createTurnWatchers(makeDeps({ resolveTranscript: () => transcriptFor(target) }));
        writeFileSync(transcriptFor('before-clear'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/old.ts' }));
        writeFileSync(transcriptFor('after-clear'), userPrompt('after clear') + toolUse('t2', 'Read', { file_path: '/new.ts' }));
        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        expect(ring.get('s1')!.length).toBeGreaterThan(0);

        // `/clear` starts a new session file. A rotation re-seeds, and a re-seed
        // that replayed would resend the whole history on every compaction.
        target = 'after-clear';
        clock += TRANSCRIPT_RECHECK_MS;
        sent = [];
        await watchers.tick('s1');

        expect(logs.some((l) => l.includes('transcript rotated'))).toBe(true);
        expect(JSON.stringify(received())).toContain('/new.ts');
        expect(JSON.stringify(received())).not.toContain('/old.ts');
    });

    it('says once, not every tick, that it cannot write the ring', async () => {
        const watchers = createTurnWatchers(
            makeDeps({ ring: { read: () => [], append: () => false, sweep: () => {} } }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', {}));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');
        appendFileSync(transcriptFor('s1'), toolUse('t2', 'Read', {}));
        await watchers.tick('s1');

        // A full disk stays full: a line every 500ms would bury the log it is
        // trying to explain. And the live send keeps going regardless.
        expect(logs.filter((l) => l.includes('ring write failed'))).toHaveLength(1);
        expect(deltas().length).toBeGreaterThan(0);
    });

    it('keeps sending when the ring itself throws', async () => {
        const watchers = createTurnWatchers(
            makeDeps({
                ring: {
                    read: () => [],
                    append: () => {
                        throw new Error('disk on fire');
                    },
                    sweep: () => {},
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', {}));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        // The ring is injected, so its contract is whatever the caller wrote.
        // An unhandled rejection here would take the poll chain down with it.
        expect(deltas().length).toBeGreaterThan(0);
    });

    it('keeps reading after a replay page the seal refused, instead of ending the watch', async () => {
        // Older than anything the transcript below will project, so the cut
        // cannot swallow the backfill and hide what this is measuring.
        ring.set('s1', [{ kind: 'tool', id: 'held', name: 'Read', at: '2020-01-01T00:00:00.000Z' }]);
        let seals = 0;
        const watchers = createTurnWatchers(
            makeDeps({
                seal: async (plaintext) => {
                    // Only the replay page fails; the backfill behind it seals.
                    if (++seals === 1) throw new Error('nope');
                    return { ciphertext: `sealed:${plaintext.length}` };
                },
            }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', { file_path: '/live.ts' }));

        watchers.handle(start('s1', { subscriberPublicKey: 'pk' }), send);
        await watchers.tick('s1');

        // One refused page is not three, so the watch survives it and the turn
        // in flight still reaches the viewer — a replay that took the session
        // down with it would cost the live lane to protect the history.
        expect(seals).toBe(2);
        expect(watchers.size()).toBe(1);
        expect(deltas()).toHaveLength(1);
        expect(logs.some((l) => l.includes('seal failed'))).toBe(true);
    });

    it('pages a long replay so no frame can exceed the transport limit', async () => {
        ring.set('s1', Array.from({ length: 60 }, (_, i) => ({ kind: 'text', text: `${i}-${'z'.repeat(1000)}` })));
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        const frames = deltas();
        expect(frames.length).toBeGreaterThan(1);
        for (const frame of frames) {
            expect(Buffer.byteLength(JSON.stringify(frame.events ?? []), 'utf-8')).toBeLessThanOrEqual(MAX_TURN_FRAME_BYTES);
        }
        // Every frame still counts, so the viewer's high-water mark advances
        // instead of discarding page two as already seen.
        expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1));
    });

    it('replays only the newest MAX_REPLAY_EVENTS, so a long history cannot outrun the viewer cap', async () => {
        ring.set(
            's1',
            Array.from({ length: MAX_REPLAY_EVENTS + 50 }, (_, i) => ({ kind: 'tool', id: `t${i}`, name: 'Read' })),
        );
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));

        watchers.handle(start('s1'), send);
        await watchers.tick('s1');

        const ids = deltas().flatMap((f) => (f.events as { id?: string }[]) ?? []).map((e) => e.id);
        expect(ids).toContain(`t${MAX_REPLAY_EVENTS + 49}`);
        expect(ids).not.toContain('t0');
    });

    it('does not record a batch the seal refused — the ring holds what was sent, not what was read', async () => {
        const watchers = createTurnWatchers(
            makeDeps({ seal: async () => { throw new Error('no key'); } }),
        );
        writeFileSync(transcriptFor('s1'), userPrompt('go') + toolUse('t1', 'Read', {}));

        watchers.handle(start('s1', { subscriberPublicKey: 'pk' }), send);
        await watchers.tick('s1');

        expect(ring.get('s1') ?? []).toEqual([]);
    });

    it('sweeps stale rings when a watch opens, so a machine that ran agents for months does not keep every one', () => {
        const watchers = createTurnWatchers(makeDeps());
        writeFileSync(transcriptFor('s1'), userPrompt('go'));

        watchers.handle(start('s1'), send);

        expect(sweeps).toBe(1);
    });
});
