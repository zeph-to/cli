import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { binaryResolves, classifyMcpRegistration, registeredMcpArgv } from './verify.js';
import { MCP_LAUNCH_ARGV, MCP_SERVERS_ENTRY, OPENCODE_MCP_ENTRY } from './mcp-command.js';

// An MCP registration is written once, at install time, and never read back.
// When it rots — the command left PATH, or it still points at the npm launcher
// `zeph mcp` replaced — the only symptom is that the agent's zeph tools quietly
// vanish. `zeph verify` is the one place that can say so.

const onPath = (bin: string) => bin === 'zeph' || bin === 'npx';
const nothingOnPath = () => false;

let TMP: string;
beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), 'sdk-verify-test-')); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

const writeJson = (rel: string, data: unknown): string => {
    const file = join(TMP, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
};

describe('registeredMcpArgv', () => {
    it('reads the command+args shape (Cursor, Windsurf, Gemini)', () => {
        const file = writeJson('mcp.json', { mcpServers: { zeph: MCP_SERVERS_ENTRY } });
        expect(registeredMcpArgv(file, 'mcpServers')).toEqual([...MCP_LAUNCH_ARGV]);
    });

    it('reads the array-command shape (opencode)', () => {
        const file = writeJson('opencode.json', { mcp: { zeph: OPENCODE_MCP_ENTRY } });
        expect(registeredMcpArgv(file, 'mcp')).toEqual([...MCP_LAUNCH_ARGV]);
    });

    it('reads a legacy npx registration verbatim rather than normalizing it away', () => {
        const file = writeJson('mcp.json', {
            mcpServers: { zeph: { command: 'npx', args: ['-y', '@zeph-to/mcp-server'] } },
        });
        expect(registeredMcpArgv(file, 'mcpServers')).toEqual(['npx', '-y', '@zeph-to/mcp-server']);
    });

    it('returns null for a missing file, unparseable JSON, or no zeph entry', () => {
        expect(registeredMcpArgv(join(TMP, 'nope.json'), 'mcpServers')).toBeNull();
        const broken = join(TMP, 'broken.json');
        writeFileSync(broken, '{ not json');
        expect(registeredMcpArgv(broken, 'mcpServers')).toBeNull();
        expect(registeredMcpArgv(writeJson('other.json', { mcpServers: { other: {} } }), 'mcpServers')).toBeNull();
    });
});

describe('classifyMcpRegistration', () => {
    it('calls the canonical launch current', () => {
        expect(classifyMcpRegistration([...MCP_LAUNCH_ARGV], onPath)).toEqual({ state: 'current' });
    });

    // The whole point of `zeph mcp`: a registration left on npx keeps paying
    // for the launcher process, and reports success while doing it.
    it('calls a surviving npx registration stale, and says what it found', () => {
        const argv = ['npx', '-y', '@zeph-to/mcp-server'];
        expect(classifyMcpRegistration(argv, onPath)).toEqual({ state: 'stale', argv });
    });

    it('calls a registration whose binary left PATH unresolvable', () => {
        const argv = ['/opt/node/v20/bin/zeph-mcp'];
        expect(classifyMcpRegistration(argv, nothingOnPath)).toEqual({ state: 'unresolvable', argv });
    });

    // Unresolvable outranks stale — a stale entry still starts a server.
    it('reports an unreachable binary even when the argv is also stale', () => {
        const argv = ['npx', '-y', '@zeph-to/mcp-server'];
        expect(classifyMcpRegistration(argv, nothingOnPath)?.state).toBe('unresolvable');
    });

    it('reports nothing for a missing or empty registration', () => {
        expect(classifyMcpRegistration(null, onPath)).toBeNull();
        expect(classifyMcpRegistration([], onPath)).toBeNull();
    });
});

describe('binaryResolves', () => {
    it('finds a bare command on PATH', () => {
        expect(binaryResolves('node')).toBe(true);
        expect(binaryResolves('definitely-not-a-real-binary-xyz')).toBe(false);
    });

    // The reason this exists instead of the shared hasCommand: that one builds
    // `which ${cmd}` as a shell string, so an absolute path containing a space
    // — ordinary on macOS — splits into two words and a working binary reports
    // as missing. Registered commands come out of a config file, not a literal.
    it('resolves an absolute path that contains a space', () => {
        const dir = mkdtempSync(join(tmpdir(), 'sdk verify space-'));
        const bin = join(dir, 'zeph');
        writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
        expect(bin).toContain(' ');
        expect(binaryResolves(bin)).toBe(true);
        expect(binaryResolves(join(dir, 'absent'))).toBe(false);
        rmSync(dir, { recursive: true, force: true });
    });

    it('does not hand the command to a shell', () => {
        expect(binaryResolves('nope; echo injected')).toBe(false);
    });
});
