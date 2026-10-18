import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { samePublicKey } from './crypto.js';
import { peerKeyOf, type PeerKeyDeps } from './peer-key.js';

const newKey = async (): Promise<string> => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    return Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
};

let dir: string;
let trustPath: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'peer-key-'));
    trustPath = join(dir, 'trusted-devices.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pinFile = (devices: Record<string, string>): void => {
    const pins = Object.fromEntries(Object.entries(devices).map(([id, publicKey]) => [id, { publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' }]));
    writeFileSync(trustPath, JSON.stringify({ version: 1, devices: pins }));
};
const pins = (): Record<string, { publicKey: string }> => JSON.parse(readFileSync(trustPath, 'utf8')).devices;
const deps = (registered: Record<string, string>, extra: Partial<PeerKeyDeps> = {}): PeerKeyDeps => ({
    registeredKey: async (id) => registered[id] ?? null,
    trustPath,
    ...extra,
});

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('peerKeyOf', () => {
    it('takes the listed key of a device seen for the first time, and pins it', async () => {
        const key = await newKey();
        expect(await peerKeyOf('dev_phone', deps({ dev_phone: key }))).toEqual({ key });
        expect(pins().dev_phone?.publicKey).toBe(key);
    });

    it('takes a pinned device\'s listed key', async () => {
        const key = await newKey();
        pinFile({ dev_phone: key, dev_other: await newKey() });
        expect(await peerKeyOf('dev_phone', deps({ dev_phone: key }))).toEqual({ key });
    });

    it('takes a changed key, moves the pin to it and warns once on stderr', async () => {
        const [before, after] = [await newKey(), await newKey()];
        pinFile({ dev_phone: before });

        expect(await peerKeyOf('dev_phone', deps({ dev_phone: after }))).toEqual({ key: after });
        expect(pins().dev_phone?.publicKey).toBe(after);
        expect(vi.mocked(console.error).mock.calls).toEqual([['[hwip] trust: dev_phone changed its key — now pinned to the new one']]);
    });

    it('takes the listed key when the trust file cannot be read, and leaves the file as it is', async () => {
        const key = await newKey();
        writeFileSync(trustPath, '{ not json');
        expect(await peerKeyOf('dev_phone', deps({ dev_phone: key }))).toEqual({ key });
        expect(readFileSync(trustPath, 'utf8')).toBe('{ not json');
    });

    it('refuses a device the account does not list, even when a pin exists', async () => {
        pinFile({ dev_phone: await newKey() });
        expect(await peerKeyOf('dev_phone', deps({}))).toEqual({ refused: 'unlisted' });
    });

    it('treats a registered key that is not a device key in its one spelling as unlisted, and pins nothing', async () => {
        const key = await newKey();
        for (const odd of ['not-a-key', key.replace(/=+$/, ''), 'A'.repeat(88)]) {
            expect(await peerKeyOf('dev_phone', deps({ dev_phone: odd }))).toEqual({ refused: 'unlisted' });
        }
        expect(() => statSync(trustPath)).toThrow();
    });

    it('refuses when the device list cannot be fetched', async () => {
        const failing: PeerKeyDeps = { registeredKey: async () => { throw new Error('devices 503'); }, trustPath };
        expect(await peerKeyOf('dev_phone', failing)).toEqual({ refused: 'devices_unavailable' });
    });

    it('answers for this machine without asking the list, and never pins it', async () => {
        const key = await newKey();
        let asked = false;
        const result = await peerKeyOf('dev_self', {
            registeredKey: async () => { asked = true; return null; },
            trustPath,
            self: { deviceId: 'dev_self', publicKey: key },
        });
        expect(result).toEqual({ key });
        expect(asked).toBe(false);
        expect(() => statSync(trustPath)).toThrow();
    });

    it('does not pin this machine when asked about it by id alone', async () => {
        const key = await newKey();
        expect(await peerKeyOf('dev_self', deps({ dev_self: key }, { selfId: 'dev_self' }))).toEqual({ key });
        expect(() => statSync(trustPath)).toThrow();
    });

    it('treats anything that is not a device id as unlisted without asking the list', async () => {
        let asked = false;
        const spy: PeerKeyDeps = { registeredKey: async () => { asked = true; return 'k'; }, trustPath };
        for (const id of ['', '../etc/passwd', 'dev phone', 'x'.repeat(65)]) {
            expect(await peerKeyOf(id, spy)).toEqual({ refused: 'unlisted' });
        }
        expect(asked).toBe(false);
    });
});

describe('samePublicKey', () => {
    it('is true only for the same key in the one spelling', async () => {
        const key = await newKey();
        expect(samePublicKey(key, key)).toBe(true);
        expect(samePublicKey(key, await newKey())).toBe(false);
    });

    it('equals nothing for any other spelling, itself included', async () => {
        const key = await newKey();
        const der = Buffer.from(key, 'base64');
        const spelled = (edit: (b: Buffer) => Buffer): string => edit(Buffer.from(der)).toString('base64');
        const odd = [
            key.replace(/=+$/, ''),
            spelled((b) => { b[26] = 0x02; return b; }),
            spelled((b) => { b[26] = 0x06; return b; }),
            spelled((b) => { b[0] = 0x31; return b; }),
            spelled((b) => b.subarray(0, 90)),
        ];
        for (const k of odd) expect(samePublicKey(k, k)).toBe(false);
    });
});
