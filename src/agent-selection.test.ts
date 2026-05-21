import { describe, expect, it } from 'vitest';
import { filterAgentsByIds } from './installer.js';
import type { Agent } from './agents.js';

// Backs `zeph install --only <ids>`. The interactive picker uses an
// @inquirer/prompts checkbox (not unit-tested here — it needs a TTY);
// filterAgentsByIds is the pure, scriptable path and is fully covered.

const mk = (...ids: string[]): Agent[] =>
    ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), detected: true }));

const ALL = mk('claude', 'cursor', 'gemini', 'copilot');

describe('filterAgentsByIds (--only)', () => {
    it('matches by agent id', () => {
        expect(filterAgentsByIds(ALL, 'cursor,gemini').map((a) => a.id)).toEqual(['cursor', 'gemini']);
    });

    it('is case-insensitive and space-tolerant', () => {
        expect(filterAgentsByIds(ALL, ' Cursor , GEMINI ').map((a) => a.id)).toEqual(['cursor', 'gemini']);
    });

    it('drops unknown ids silently', () => {
        expect(filterAgentsByIds(ALL, 'cursor,bogus,vscode').map((a) => a.id)).toEqual(['cursor']);
    });

    it('empty string → no agents', () => {
        expect(filterAgentsByIds(ALL, '')).toEqual([]);
    });

    it('single id', () => {
        expect(filterAgentsByIds(ALL, 'claude').map((a) => a.id)).toEqual(['claude']);
    });

    it('output follows detected order, not input order', () => {
        expect(filterAgentsByIds(ALL, 'copilot,claude').map((a) => a.id)).toEqual(['claude', 'copilot']);
    });

    it('de-duplicates repeated ids', () => {
        expect(filterAgentsByIds(ALL, 'cursor,cursor').map((a) => a.id)).toEqual(['cursor']);
    });
});
