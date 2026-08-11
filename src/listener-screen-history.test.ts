/**
 * Deep pull: reading the pane's scrollback from the phone.
 *
 * The live stream captures a fixed window (STREAM_CAPTURE_LINES) and every
 * frame is capped at SCREEN_PEEK_MAX_BYTES, which is sized for API Gateway's
 * 32KB WebSocket frame. Raising either is the wrong lever — the first only
 * grows what each frame captures and throws away, the second breaks the
 * transport. So history is a separate, one-shot request: the phone asks for one
 * page above what it already holds, and pages upward from there.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const FIELD_SEP = '␟';
const SESSIONS = ['zeph-a', 'zeph-short'];

let tmuxCalls: string[][] = [];
/** Scrollback depth the fake tmux reports, per session. */
let historySize: Record<string, number> = {};
/** Lines the fake pane holds, oldest first, addressed the way tmux does it. */
let paneLines: string[] = [];
let captureFails = false;

/**
 * tmux `capture-pane -S <start> -E <end>`: line 0 is the top of the visible
 * pane and negative numbers reach back into the history. The fake mirrors that
 * addressing so the range arithmetic under test is checked against tmux's own
 * coordinates, not against a convention invented here.
 */
const captureRange = (start: number, end: number): string => {
  const depth = paneLines.length;
  // Index 0 of paneLines is the OLDEST line, which sits at tmux line -depth.
  const from = Math.max(0, depth + start);
  const to = Math.min(depth - 1, depth + end);
  if (from > to) return '';
  return paneLines.slice(from, to + 1).join('\n') + '\n';
};

const fakeTmux = (args: readonly string[]) => {
  const a = args[0] === '-S' ? args.slice(2) : args;
  tmuxCalls.push([...a]);
  if (a[0] === 'list-sessions') {
    const stdout = SESSIONS.map((n) => [n, '0', '1700000000', '1700000000'].join(FIELD_SEP)).join('\n');
    return { status: 0, stdout, stderr: '' };
  }
  if (a[0] === 'display-message') {
    const session = a[3];
    if (a[4] === '#{history_size}') {
      return { status: 0, stdout: String(historySize[session] ?? 0), stderr: '' };
    }
    if (a[4] === '#{pane_current_command}') return { status: 0, stdout: 'node', stderr: '' };
    return { status: 0, stdout: ['node', 'claude', '/tmp/proj', '1234'].join(FIELD_SEP), stderr: '' };
  }
  if (a[0] === 'capture-pane') {
    if (captureFails) return { status: 1, stdout: '', stderr: 'no pane' };
    const start = Number(a[a.indexOf('-S') + 1]);
    const end = a.includes('-E') ? Number(a[a.indexOf('-E') + 1]) : 0;
    return { status: 0, stdout: captureRange(start, end), stderr: '' };
  }
  return { status: 1, stdout: '', stderr: '' };
};

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: (cmd: string, args?: readonly string[]) =>
      cmd === 'tmux' ? fakeTmux(args ?? []) : { status: 1, stdout: '', stderr: '' },
  };
});

const TMP = mkdtempSync(join(tmpdir(), 'zeph-history-'));
process.env.HOME = TMP;
process.env.XDG_STATE_HOME = join(TMP, 'state');

const {
  handleScreenHistoryRequest,
  handleStreamControl,
  stopAllStreams,
  computeListenerDeviceId,
  STREAM_CAPTURE_LINES,
  SCREEN_HISTORY_MAX_LINES,
} = await import('./listener.js');

/** A pane whose scrollback is `n` numbered lines, oldest first. */
const fillPane = (n: number) => {
  paneLines = Array.from({ length: n }, (_, i) => `line-${i}`);
  historySize = { 'zeph-a': n, 'zeph-short': n };
};

describe('agent.screen.history.request — one page of scrollback above the live window', () => {
  const device = computeListenerDeviceId();

  const request = (over: Record<string, unknown> = {}) => ({
    subtype: 'agent.screen.history.request',
    targetDeviceId: device,
    sessionName: 'zeph-a',
    requestId: 'r1',
    before: 200,
    lines: 10,
    ...over,
  });

  /** Replies the handler put on the ephemeral channel, in order. */
  let sent: Array<Record<string, unknown>>;
  const send = (data: Record<string, unknown>) => { sent.push(data); };

  /** Ask, and hand back what came out. */
  const ask = (over: Record<string, unknown> = {}) => {
    const claimed = handleScreenHistoryRequest(request(over), send);
    return { claimed, reply: sent.at(-1) };
  };

  /**
   * A history pull answers only under a live stream lease — that lease carries
   * the subscriber key the page has to be sealed for.
   */
  const openStream = (subscriberPublicKey?: string) => {
    handleStreamControl(
      {
        subtype: 'agent.stream.start',
        targetDeviceId: device,
        sessionName: 'zeph-a',
        renew: true,
        ...(subscriberPublicKey ? { subscriberPublicKey } : {}),
      },
      send,
    );
    sent = [];
    tmuxCalls = [];
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tmuxCalls = [];
    sent = [];
    captureFails = false;
    fillPane(STREAM_CAPTURE_LINES + 100);
  });
  afterEach(() => {
    stopAllStreams();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The history captures only. The inventory sweep and the stream loop capture
   *  panes too, and those are not what these assert. */
  const historyCaptures = () =>
    tmuxCalls.filter((c) => c[0] === 'capture-pane' && c.includes('-E'));

  describe('routing', () => {
    it('does not claim other ephemeral traffic', () => {
      expect(handleScreenHistoryRequest({ subtype: 'clipboard', targetDeviceId: device }, send)).toBe(false);
      expect(handleScreenHistoryRequest({}, send)).toBe(false);
      // The one-shot peek is a different subtype and keeps its own handler.
      expect(handleScreenHistoryRequest(request({ subtype: 'agent.screen.request' }), send)).toBe(false);
      expect(sent).toEqual([]);
    });

    it('ignores a request addressed to another machine', () => {
      expect(ask({ targetDeviceId: 'dev_someone_else' }).claimed).toBe(false);
    });

    it('ignores a request with no requestId or no session', () => {
      expect(ask({ requestId: undefined }).claimed).toBe(false);
      expect(ask({ sessionName: undefined }).claimed).toBe(false);
      expect(sent).toEqual([]);
    });

    // Same posture as the peek: the phone may read exactly the panes the
    // inventory already exposes to it, and nothing else.
    it('refuses a session the inventory does not expose, without touching the pane', () => {
      openStream();
      expect(ask({ sessionName: 'zeph-not-there' }).reply?.error).toBe('unknown_session');
      expect(tmuxCalls.some((c) => c.includes('zeph-not-there'))).toBe(false);
    });

    // Without a lease there is no subscriber key, so a page could only be
    // answered in the clear — which is the downgrade the stream half refuses.
    it('refuses a pull with no live stream behind it', () => {
      const { reply } = ask();

      expect(reply?.error).toBe('no_stream');
      expect(historyCaptures()).toHaveLength(0);
    });

    it('reports a failed capture instead of answering with an empty page', () => {
      openStream();
      captureFails = true;

      expect(ask().reply?.error).toBe('capture_failed');
      expect(ask().reply?.content).toBeUndefined();
    });
  });

  describe('range', () => {
    beforeEach(() => openStream());

    it('reads the page directly above the scrollback the caller holds', () => {
      const { reply } = ask({ before: 200, lines: 10 });

      const capture = historyCaptures()[0];
      expect(capture[capture.indexOf('-S') + 1]).toBe('-210');
      expect(capture[capture.indexOf('-E') + 1]).toBe('-201');
      expect(reply?.error).toBeUndefined();
      expect(reply?.lines).toBe(10);
    });

    it('walks further back as the caller reports more held lines', () => {
      ask({ before: 210, lines: 10 });

      const capture = historyCaptures()[0];
      expect(capture[capture.indexOf('-S') + 1]).toBe('-220');
      expect(capture[capture.indexOf('-E') + 1]).toBe('-211');
    });

    // The frame the caller holds may have been trimmed by the byte cap, so it
    // holds FEWER lines than the capture asked for. Starting the page at the
    // constant instead would skip the lines in between, and no later page can
    // reach back down to them.
    it('starts where a truncated frame actually ends, not where the constant says', () => {
      ask({ before: 12, lines: 10 });

      const capture = historyCaptures()[0];
      expect(capture[capture.indexOf('-S') + 1]).toBe('-22');
      expect(capture[capture.indexOf('-E') + 1]).toBe('-13');
    });

    it('assumes the full capture window when the caller names no offset', () => {
      ask({ before: undefined, lines: 10 });

      const capture = historyCaptures()[0];
      expect(capture[capture.indexOf('-S') + 1]).toBe(String(-(STREAM_CAPTURE_LINES + 10)));
      expect(capture[capture.indexOf('-E') + 1]).toBe(String(-(STREAM_CAPTURE_LINES + 1)));
    });

    it('returns the lines that sit there, contiguous with the page before it', () => {
      const depth = STREAM_CAPTURE_LINES + 100;
      const first = ask({ before: 200, lines: 10 }).reply;
      const second = ask({ before: 210, lines: 10, requestId: 'r2' }).reply;

      const firstTop = depth - 210;
      expect(String(first?.content).split('\n')[0]).toBe(`line-${firstTop}`);
      expect(String(second?.content).split('\n').filter(Boolean).at(-1)).toBe(`line-${firstTop - 1}`);
    });

    it('keeps the ANSI colours, the way the live frames do', () => {
      ask();

      expect(historyCaptures()[0]).toContain('-e');
    });
  });

  describe('ends of the history', () => {
    beforeEach(() => openStream());

    it('says there is more above the page it returned', () => {
      expect(ask({ before: 200, lines: 10 }).reply?.hasMore).toBe(true);
    });

    it('says there is nothing more once the page reaches the oldest line', () => {
      fillPane(STREAM_CAPTURE_LINES + 10);
      const { reply } = ask({ before: 200, lines: 10 });

      expect(reply?.lines).toBe(10);
      expect(reply?.hasMore).toBe(false);
    });

    // Asking past the top is what the client does when it has scrolled to the
    // end: answer emptily rather than with an error, so the view can just stop.
    it('answers an exhausted history with an empty page, not an error', () => {
      fillPane(STREAM_CAPTURE_LINES + 5);
      const { reply } = ask({ before: STREAM_CAPTURE_LINES + 5, lines: 10 });

      expect(reply?.error).toBeUndefined();
      expect(reply?.content).toBe('');
      expect(reply?.lines).toBe(0);
      expect(reply?.hasMore).toBe(false);
      expect(historyCaptures()).toHaveLength(0);
    });
  });

  describe('what the caller is allowed to ask for', () => {
    beforeEach(() => openStream());

    it('caps the page size — a page the transport cannot carry helps nobody', () => {
      ask({ before: 0, lines: SCREEN_HISTORY_MAX_LINES + 500 });

      const capture = historyCaptures()[0];
      expect(capture[capture.indexOf('-S') + 1]).toBe(String(-SCREEN_HISTORY_MAX_LINES));
    });

    // These numbers become tmux argv. A fractional or negative one would build
    // a range nobody can reason about, so it is refused rather than coerced.
    it('refuses a range that is not whole and non-negative', () => {
      for (const bad of [-1, 1.5, NaN, Infinity]) {
        expect(ask({ before: bad }).reply?.error).toBe('bad_range');
        expect(ask({ lines: bad }).reply?.error).toBe('bad_range');
      }
      expect(historyCaptures()).toHaveLength(0);
    });

    it('refuses a range whose numbers are not numbers at all', () => {
      expect(ask({ before: '10' }).reply?.error).toBe('bad_range');
      expect(ask({ lines: 'ten' }).reply?.error).toBe('bad_range');
    });

    // JSON has no undefined: a client that omits a field may send null for it,
    // and that means "unspecified", not "zero lines".
    it('reads a default page when a field arrives as null', () => {
      const { reply } = ask({ before: null, lines: null });

      expect(reply?.error).toBeUndefined();
      expect(Number(reply?.lines)).toBeGreaterThan(0);
    });
  });

  describe('payload cap', () => {
    beforeEach(() => openStream());

    it('trims from the top and reports how many lines actually came back', () => {
      // 40KB of history in a 10-line page: past SCREEN_PEEK_MAX_BYTES, so the
      // reply is cut. Cutting from the TOP is what keeps the page contiguous
      // with what the client already has — and `lines` is what it advances by.
      paneLines = Array.from({ length: STREAM_CAPTURE_LINES + 20 }, () => 'x'.repeat(4096));
      historySize = { 'zeph-a': paneLines.length };

      const { reply } = ask({ before: 200, lines: 10 });

      expect(reply?.truncated).toBe(true);
      expect(Number(reply?.lines)).toBeLessThan(10);
      expect(Number(reply?.lines)).toBeGreaterThan(0);
      expect(Buffer.byteLength(String(reply?.content), 'utf-8')).toBeLessThanOrEqual(24 * 1024);
    });
  });

  /**
   * History is the same pane text the frames carry. A stream the user chose to
   * encrypt must not hand that text to the relay just because it was asked for
   * by scrolling instead of by watching.
   */
  describe('an encrypted stream', () => {
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

    /** The seal is async (an ECDH derive, then AES): pump until the reply that
     *  it produces shows up, rather than guessing at a number of ticks. */
    const flush = async () => {
      for (let i = 0; i < 50 && sent.length === 0; i++) await vi.advanceTimersByTimeAsync(1);
    };

    it('seals the page for the subscriber instead of sending it in the clear', async () => {
      const { initDeviceCrypto } = await import('./crypto.js');
      await initDeviceCrypto();
      openStream(await recipientKey());

      handleScreenHistoryRequest(request({ before: 200, lines: 10 }), send);
      await flush();

      const reply = sent.at(-1);
      expect(reply?.content).toBeUndefined();
      expect(reply?.encrypted).toBeDefined();
      const ciphertext = (reply?.encrypted as { ciphertext: string }).ciphertext;
      expect(ciphertext).not.toContain('line-');
      // The page metadata still rides in the clear, exactly as the frames do:
      // a line count without the lines says nothing.
      expect(reply?.lines).toBe(10);
      expect(reply?.hasMore).toBe(true);
    });

    it('reports a failed seal rather than falling back to plaintext', async () => {
      openStream('not-a-key');

      handleScreenHistoryRequest(request({ before: 200, lines: 10 }), send);
      await flush();

      const reply = sent.at(-1);
      expect(reply?.error).toBe('encrypt_failed');
      expect(reply?.content).toBeUndefined();
      expect(reply?.encrypted).toBeUndefined();
    });

    it('sends the page in the clear only when the stream itself is in the clear', () => {
      openStream();

      handleScreenHistoryRequest(request({ before: 200, lines: 10 }), send);

      expect(sent.at(-1)?.content).toContain('line-');
      expect(sent.at(-1)?.encrypted).toBeUndefined();
    });
  });
});
