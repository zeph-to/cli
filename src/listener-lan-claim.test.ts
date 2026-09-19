import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimLanFile, displayFolder, gcAttachments, handlePush } from './listener.js';

// The last step of a local transfer: the receiver left the decrypted file
// in the landing zone, the push record arrives over the WebSocket, and the
// file moves to Downloads. Pinned: the never-overwrite rule survives the
// move, a missing transfer is a quiet null, and orphans get swept.

const zone = () => {
    const landing = mkdtempSync(join(tmpdir(), 'zeph-landing-'));
    const downloads = mkdtempSync(join(tmpdir(), 'zeph-downloads-'));
    const land = (transferId: string, fileName: string, content: string) => {
        mkdirSync(join(landing, transferId), { recursive: true });
        writeFileSync(join(landing, transferId, fileName), content);
    };
    return { landing, downloads, land };
};

describe('claimLanFile', () => {
    it('moves <landing>/<transferId>/<fileName> to Downloads and removes the transfer dir', () => {
        const z = zone();
        z.land('tr_1', 'a.txt', 'A');
        const dest = claimLanFile({ fileName: 'a.txt', transferId: 'tr_1' }, z.landing, z.downloads);
        expect(dest).toBe(join(z.downloads, 'a.txt'));
        expect(readFileSync(dest ?? '').toString()).toBe('A');
        expect(existsSync(join(z.landing, 'tr_1'))).toBe(false);
    });

    it('never overwrites: a second file of the same name becomes name (2)', () => {
        const z = zone();
        writeFileSync(join(z.downloads, 'a.txt'), 'old');
        z.land('tr_2', 'a.txt', 'new');
        const dest = claimLanFile({ fileName: 'a.txt', transferId: 'tr_2' }, z.landing, z.downloads);
        expect(dest).toBe(join(z.downloads, 'a (2).txt'));
        expect(readFileSync(join(z.downloads, 'a.txt')).toString()).toBe('old');
    });

    it('looks the file up by the same safe name the receiver wrote it under', () => {
        const z = zone();
        z.land('tr_3', 'escape.txt', 'E');   // what the receiver stored for '../../escape.txt'
        const dest = claimLanFile({ fileName: '../../escape.txt', transferId: 'tr_3' }, z.landing, z.downloads);
        expect(dest).toBe(join(z.downloads, 'escape.txt'));
    });

    it('null when the transfer is not there; a malformed transferId cannot name a path', () => {
        const z = zone();
        expect(claimLanFile({ fileName: 'a', transferId: 'tr_none' }, z.landing, z.downloads)).toBeNull();
        expect(() => claimLanFile({ fileName: 'a', transferId: '../x' }, z.landing, z.downloads)).toThrow(/malformed transferId/);
    });
});

describe('gcAttachments — landing zone', () => {
    it('sweeps old lan/<transferId> dirs but keeps the zone and young transfers', () => {
        const root = mkdtempSync(join(tmpdir(), 'zeph-att-'));
        const lan = join(root, 'lan');
        mkdirSync(join(lan, 'tr_old'), { recursive: true });
        mkdirSync(join(lan, 'tr_new'), { recursive: true });
        mkdirSync(join(root, 'push_old'), { recursive: true });
        mkdirSync(join(lan, 'lan'), { recursive: true });   // a transfer literally named `lan` is just a transfer
        const now = 10_000_000;
        const ttl = 1_000;
        const old = new Date(now - 5_000);
        utimesSync(join(lan, 'tr_old'), old, old);
        utimesSync(join(root, 'push_old'), old, old);
        utimesSync(lan, old, old);                     // the zone itself is old, must survive
        utimesSync(join(lan, 'lan'), old, old);
        utimesSync(join(lan, 'tr_new'), new Date(now), new Date(now));
        expect(gcAttachments(now, root, ttl, lan)).toBe(3);   // push_old + lan/tr_old + lan/lan
        expect(existsSync(join(lan, 'tr_old'))).toBe(false);
        expect(existsSync(join(lan, 'lan'))).toBe(false);
        expect(existsSync(join(lan, 'tr_new'))).toBe(true);
        expect(existsSync(lan)).toBe(true);              // the zone survives even when it is old itself
        expect(existsSync(join(root, 'push_old'))).toBe(false);
    });
});

describe('handlePush — lanDeliveredTo', () => {
    const deps = (claim: (f: { fileName: string; transferId?: string }) => Promise<string | null>) => {
        const notes: { title: string; body: string; reveal?: string }[] = [];
        return {
            notes,
            deps: {
                deviceId: () => 'dev_me',
                claimLanFile: claim,
                saveFile: async () => { throw new Error('S3 must not be touched for a LAN file'); },
                notify: async (n: { title: string; body: string; reveal?: string }) => { notes.push(n); return true; },
            },
        };
    };
    const push = (lanDeliveredTo: string) => ({
        pushId: 'p', type: 'file', title: '[app] big.mov', senderDeviceId: 'dev_mcp', targetDeviceId: 'dev_me',
        files: [{ fileName: 'big.mov', lanDeliveredTo, transferId: 'tr_9' }],
    });

    it('delivered to this device: claims it, banner, true', async () => {
        const d = deps(async (f) => `/home/u/Downloads/Zeph/${f.fileName}`);
        expect(await handlePush(push('dev_me'), d.deps)).toBe(true);
        // The banner says where the file is and a click can take you there:
        // the title is the name it was saved under, the body the folder.
        expect(d.notes).toEqual([{
            title: 'Zeph · big.mov',
            body: `from [app] big.mov · ${displayFolder('/home/u/Downloads/Zeph/big.mov')}`,
            reveal: '/home/u/Downloads/Zeph/big.mov',
        }]);
    });

    it('not in the landing zone (orphan swept, or duplicated push.new): logged, no banner, false', async () => {
        const d = deps(async () => null);
        expect(await handlePush(push('dev_me'), d.deps)).toBe(false);
        expect(d.notes).toEqual([]);
    });

    it('delivered to another device: nothing claimed, false', async () => {
        let claimed = false;
        const d = deps(async () => { claimed = true; return null; });
        expect(await handlePush({ ...push('dev_other'), targetDeviceId: undefined }, d.deps)).toBe(false);
        expect(claimed).toBe(false);
    });

    it('a claim that throws is logged and does not fail the push handler', async () => {
        const d = deps(async () => { throw new Error('EACCES'); });
        await expect(handlePush(push('dev_me'), d.deps)).resolves.toBe(false);
    });
});

describe('displayFolder', () => {
    it('shows the home prefix as ~', () => {
        expect(displayFolder('/Users/me/Downloads/Zeph/a (2).txt', '/Users/me')).toBe('~/Downloads/Zeph');
    });

    it('leaves a folder outside home, or one that only shares its prefix, as it is', () => {
        expect(displayFolder('/Volumes/x/a.txt', '/Users/me')).toBe('/Volumes/x');
        expect(displayFolder('/Users/meg/a.txt', '/Users/me')).toBe('/Users/meg');
    });
});
