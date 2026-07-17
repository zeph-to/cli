import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// The listener daemon writes this file (see listener.ts computeListenerDeviceId);
// non-listener processes in the CLI (zeph-hook's agent-session context) only
// READ it, so both resolve the same id without racing the write.
const LISTENER_ID_FILE = join(homedir(), '.zeph', 'listener-device-id');

const hashListenerId = (seed: string): string =>
    `dev_listener_${createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;

/** Platform machine id (macOS IOPlatformUUID / Linux machine-id), or null. */
const readMachineId = (): string | null => {
    try {
        if (process.platform === 'darwin') {
            // stdio: swallow ioreg's stderr so a one-off `zeph rename` / hook
            // never leaks ioreg warnings to the terminal (matches listener.ts).
            const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
            if (m) return m[1];
        }
        if (process.platform === 'linux') {
            for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
                try {
                    const v = readFileSync(p, 'utf-8').trim();
                    if (v) return v;
                } catch { /* try next path */ }
            }
        }
    } catch { /* no machine id readable — fall through */ }
    return null;
};

/**
 * Listener device id, resolved READ-ONLY — MUST equal what `listener.ts`
 * `computeListenerDeviceId()` registers, so pushes tagged with this id land
 * under the listener's device (otherwise a hook/notify reaches the feed but
 * never threads into the agent chat). Hash the platform machine id first, then
 * the sticky file the listener persisted, then a hostname hash — the same order
 * as the writer, but never writing the file here.
 */
export const listenerDeviceId = (): string => {
    const machineId = readMachineId();
    if (machineId) return hashListenerId(machineId);
    try {
        const saved = readFileSync(LISTENER_ID_FILE, 'utf-8').trim();
        if (/^dev_listener_[0-9a-f]{8}$/.test(saved)) return saved;
    } catch { /* no sticky file — fall back to hostname */ }
    return hashListenerId(hostname());
};
