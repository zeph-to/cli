import { describe, expect, it } from 'vitest';
import { installedMcpServerVersion, isNewer } from './check-update.js';

// isNewer backs `zeph check-update` — if it's wrong, users either miss
// real updates or get nagged about phantom ones.

describe('isNewer', () => {
    it('detects a newer patch', () => {
        expect(isNewer('1.0.1', '1.0.0')).toBe(true);
    });

    it('detects a newer minor', () => {
        expect(isNewer('1.1.0', '1.0.9')).toBe(true);
    });

    it('detects a newer major', () => {
        expect(isNewer('2.0.0', '1.9.9')).toBe(true);
    });

    it('returns false for equal versions', () => {
        expect(isNewer('1.2.3', '1.2.3')).toBe(false);
    });

    it('returns false when current is ahead', () => {
        expect(isNewer('1.0.0', '1.0.1')).toBe(false);
        expect(isNewer('1.9.9', '2.0.0')).toBe(false);
    });

    it('tolerates a leading v', () => {
        expect(isNewer('v1.0.1', 'v1.0.0')).toBe(true);
        expect(isNewer('v1.0.0', 'v1.0.0')).toBe(false);
    });

    it('ignores prerelease suffixes (compares release portion)', () => {
        // 0.0.0-semantic-release is the placeholder version in package.json
        expect(isNewer('1.10.0', '0.0.0-semantic-release')).toBe(true);
        expect(isNewer('0.0.0', '0.0.0-semantic-release')).toBe(false);
    });

    it('handles uneven segment counts', () => {
        expect(isNewer('1.2', '1.1.9')).toBe(true);
        expect(isNewer('1', '1.0.0')).toBe(false);
    });
});

// mcp-server used to be reported without an installed version — it arrived via
// `npx -y`, so the CLI genuinely could not know what was on the machine. `zeph
// mcp` runs it in-process from a dependency, so the version is knowable. The
// deep `package.json` path is the fragile part (it works because the package
// declares no `exports` map), and that is what this pins.
describe('installedMcpServerVersion', () => {
    it('resolves the bundled mcp-server version', () => {
        expect(installedMcpServerVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });
});
