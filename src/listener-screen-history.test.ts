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
    before: 0,
    lines: 10,
    ...over,
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tmuxCalls = [];
    captureFails = false;
    fillPane(STREAM_CAPTURE_LINES + 100);
  });
  afterEach(() => vi.restoreAllMocks());

  /** The history captures only. The inventory sweep captures panes too (that
   *  is how session state is derived), and those are not what these assert. */
  const historyCaptures = () =>
    tmuxCalls.filter((c) => c[0] === 'capture-pane' && c.includes('-E'));

  describe('routing', () => {
    it('does not claim other ephemeral traffic', () => {
      expect(handleScreenHistoryRequest({ subtype: 'clipboard', targetDeviceId: device })).toBeNull();
      expect(handleScreenHistoryRequest({})).toBeNull();
      // The one-shot peek is a different subtype and keeps its own handler.
      expect(handleScreenHistoryRequest(request({ subtype: 'agent.screen.request' }))).toBeNull();
    });

    it('ignores a request addressed to another machine', () => {
      expect(handleScreenHistoryRequest(request({ targetDeviceId: 'dev_someone_else' }))).toBeNull();
    });

    it('ignores a request with no requestId or no session', () => {
      expect(handleScreenHistoryRequest(request({ requestId: undefined }))).toBeNull();
      expect(handleScreenHistoryRequest(request({ sessionName: undefined }))).toBeNull();
    });

    // Same posture as the peek: the phone may read exactly the panes the
    // inventory already exposes to it, and nothing else.
    it('refuses a session the inventory does not expose, without touching the pane', () => {
      const reply = handleScreenHistoryRequest(request({ sessionName: 'zeph-not-there' }));

      expect(reply?.error).toBe('unknown_session');
      expect(tmuxCalls.some((c) => c.includes('zeph-not-there'))).toBe(false);
    });

    it('reports a failed capture instead of answering with an empty page', () => {
      captureFails = true;
      const reply = handleScreenHistoryRequest(request());

      expect(reply?.error).toBe('capture_failed');
      expect(reply?.content).toBeUndefined();
    });
  });

  describe('range', () => {
    it('reads the page immediately above the live window', () => {
      const reply = handleScreenHistoryRequest(request({ before: 0, lines: 10 }));

      const capture = historyCaptures()[0];
      expect(capture[capture.indexOf('-S') + 1]).toBe(String(-(STREAM_CAPTURE_LINES + 10)));
      expect(capture[capture.indexOf('-E') + 1]).toBe(String(-(STREAM_CAPTURE_LINES + 1)));
      expect(reply?.error).toBeUndefined();
      expect(reply?.lines).toBe(10);
    });

    it('walks further back as the client reports what it already holds', () => {
      handleScreenHistoryRequest(request({ before: 10, lines: 10 }));

      const capture = historyCaptures()[0];
      expect(capture[capture.indexOf('-S') + 1]).toBe(String(-(STREAM_CAPTURE_LINES + 20)));
      expect(capture[capture.indexOf('-E') + 1]).toBe(String(-(STREAM_CAPTURE_LINES + 11)));
    });

    it('returns the lines that sit there, contiguous with the page before it', () => {
      const depth = STREAM_CAPTURE_LINES + 100;
      const first = handleScreenHistoryRequest(request({ before: 0, lines: 10 }));
      const second = handleScreenHistoryRequest(request({ before: 10, lines: 10, requestId: 'r2' }));

      // The live window holds the last STREAM_CAPTURE_LINES lines, so page one
      // ends just above it and page two ends where page one began.
      const firstTop = depth - STREAM_CAPTURE_LINES - 10;
      expect(first?.content?.split('\n')[0]).toBe(`line-${firstTop}`);
      expect(second?.content?.split('\n').filter(Boolean).at(-1)).toBe(`line-${firstTop - 1}`);
    });

    it('keeps the ANSI colours, the way the live frames do', () => {
      handleScreenHistoryRequest(request());

      expect(historyCaptures()[0]).toContain('-e');
    });
  });

  describe('ends of the history', () => {
    it('says there is more above the page it returned', () => {
      const reply = handleScreenHistoryRequest(request({ before: 0, lines: 10 }));

      expect(reply?.hasMore).toBe(true);
    });

    it('says there is nothing more once the page reaches the oldest line', () => {
      fillPane(STREAM_CAPTURE_LINES + 10);
      const reply = handleScreenHistoryRequest(request({ before: 0, lines: 10 }));

      expect(reply?.lines).toBe(10);
      expect(reply?.hasMore).toBe(false);
    });

    // Asking past the top is what the client does when it has scrolled to the
    // end: answer emptily rather than with an error, so the view can just stop.
    it('answers an exhausted history with an empty page, not an error', () => {
      fillPane(STREAM_CAPTURE_LINES + 5);
      const reply = handleScreenHistoryRequest(request({ before: 5, lines: 10 }));

      expect(reply?.error).toBeUndefined();
      expect(reply?.content).toBe('');
      expect(reply?.lines).toBe(0);
      expect(reply?.hasMore).toBe(false);
      expect(historyCaptures()).toHaveLength(0);
    });
  });

  describe('what the caller is allowed to ask for', () => {
    it('caps the page size — a page the transport cannot carry helps nobody', () => {
      handleScreenHistoryRequest(request({ before: 0, lines: SCREEN_HISTORY_MAX_LINES + 500 }));

      const capture = historyCaptures()[0];
      expect(capture[capture.indexOf('-S') + 1]).toBe(
        String(-(STREAM_CAPTURE_LINES + SCREEN_HISTORY_MAX_LINES)),
      );
    });

    // These numbers become tmux argv. A fractional or negative one would build
    // a range nobody can reason about, so it is refused rather than coerced.
    it('refuses a range that is not whole and non-negative', () => {
      for (const bad of [-1, 1.5, NaN, Infinity]) {
        expect(handleScreenHistoryRequest(request({ before: bad }))?.error).toBe('bad_range');
        expect(handleScreenHistoryRequest(request({ lines: bad }))?.error).toBe('bad_range');
      }
      expect(historyCaptures()).toHaveLength(0);
    });

    it('refuses a range whose numbers are not numbers at all', () => {
      expect(handleScreenHistoryRequest(request({ before: '10' }))?.error).toBe('bad_range');
      expect(handleScreenHistoryRequest(request({ lines: 'ten' }))?.error).toBe('bad_range');
    });

    // JSON has no undefined: a client that omits a field may send null for it,
    // and that means "unspecified", not "zero lines".
    it('reads a default page when a field arrives as null', () => {
      const reply = handleScreenHistoryRequest(request({ before: null, lines: null }));

      expect(reply?.error).toBeUndefined();
      expect(reply?.lines).toBeGreaterThan(0);
    });

    it('reads one default page when the caller names no size', () => {
      const reply = handleScreenHistoryRequest(request({ before: undefined, lines: undefined }));

      expect(reply?.error).toBeUndefined();
      expect(reply?.lines).toBeGreaterThan(0);
    });
  });

  describe('payload cap', () => {
    it('trims from the top and reports how many lines actually came back', () => {
      // 40KB of history in a 10-line page: past SCREEN_PEEK_MAX_BYTES, so the
      // reply is cut. Cutting from the TOP is what keeps the page contiguous
      // with what the client already has — and `lines` is what it advances by.
      paneLines = Array.from({ length: STREAM_CAPTURE_LINES + 20 }, () => 'x'.repeat(4096));
      historySize = { 'zeph-a': paneLines.length };

      const reply = handleScreenHistoryRequest(request({ before: 0, lines: 10 }));

      expect(reply?.truncated).toBe(true);
      expect(reply?.lines).toBeLessThan(10);
      expect(reply?.lines).toBeGreaterThan(0);
      expect(Buffer.byteLength(reply?.content ?? '', 'utf-8')).toBeLessThanOrEqual(24 * 1024);
    });
  });
});
