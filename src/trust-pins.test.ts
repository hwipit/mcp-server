import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { publicKeySender } from './crypto.js';
import { keyChangesPath, takeKeyChanges } from './key-changes.js';
import { MAX_PINNED_DEVICES, observeDevices, withTrustLock } from './trust-pins.js';

const newKey = async (): Promise<string> => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    return Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
};

const AT = new Date('2026-10-12T10:00:00.000Z');
const OLD = '2026-10-01T00:00:00.000Z';

let dir: string;
let trustPath: string;
let lockPath: string;
let warned: string[];
const opts = (selfId = 'dev_self') => ({ selfId, now: () => AT, warn: (line: string) => { warned.push(line); } });

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trust-pins-'));
    trustPath = join(dir, 'trusted-devices.json');
    lockPath = join(dir, 'trusted-devices.lock');
    warned = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (body: unknown): void => writeFileSync(trustPath, JSON.stringify(body));
const read = (): Record<string, unknown> & { devices: Record<string, { publicKey: string; pinnedAt: string }> } =>
    JSON.parse(readFileSync(trustPath, 'utf8'));

describe('observeDevices', () => {
    it('pins every listed device with a key the first time it is seen, but not this machine', async () => {
        const [phone, mac, self] = [await newKey(), await newKey(), await newKey()];
        const seen = observeDevices(trustPath, [
            { deviceId: 'dev_phone', publicKey: phone },
            { deviceId: 'dev_mac', publicKey: mac },
            { deviceId: 'dev_self', publicKey: self },
            { deviceId: 'dev_keyless' },
            { deviceId: '../etc', publicKey: await newKey() },
            { deviceId: 'dev_odd', publicKey: 'not-a-key' },
        ], opts());

        expect(seen).toEqual({ pinned: ['dev_phone', 'dev_mac'], replaced: [], skipped: [], status: 'ok' });
        expect(read()).toEqual({ version: 1, devices: { dev_phone: { publicKey: phone, pinnedAt: AT.toISOString() }, dev_mac: { publicKey: mac, pinnedAt: AT.toISOString() } } });
        expect(statSync(trustPath).mode & 0o777).toBe(0o600);
        expect(warned).toEqual([]);
        expect(existsSync(lockPath)).toBe(false);
    });

    it('writes nothing when every device is pinned with the key it lists', async () => {
        const phone = await newKey();
        write({ version: 1, devices: { dev_phone: { publicKey: phone, pinnedAt: OLD } } });
        const before = readFileSync(trustPath, 'utf8');

        expect(observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: phone }], opts()).status).toBe('ok');
        expect(readFileSync(trustPath, 'utf8')).toBe(before);

        rmSync(trustPath);
        observeDevices(trustPath, [{ deviceId: 'dev_keyless' }], opts());
        expect(existsSync(trustPath)).toBe(false);
    });

    it('replaces a changed key with one warning, and says nothing the next time', async () => {
        const [before, after] = [await newKey(), await newKey()];
        write({ version: 1, devices: { dev_phone: { publicKey: before, pinnedAt: OLD } } });

        expect(observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: after }], opts())).toEqual({ pinned: [], replaced: ['dev_phone'], skipped: [], status: 'ok' });
        expect(read().devices.dev_phone).toEqual({ publicKey: after, pinnedAt: AT.toISOString() });
        expect(warned).toEqual(['trust: dev_phone changed its key — now pinned to the new one']);

        observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: after }], opts());
        expect(warned).toHaveLength(1);
    });

    it('records a replaced pin for a person to see, with the name the list gives', async () => {
        observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey() }], opts());
        expect(existsSync(keyChangesPath(trustPath))).toBe(false);

        observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey(), nickname: 'iPhone' }], opts());

        expect(takeKeyChanges(trustPath)).toEqual([{ deviceId: 'dev_phone', at: AT.toISOString(), name: 'iPhone' }]);
    });

    // The pin holds the new key now: the next send sees `same`, so the change is held for this process's next result.
    it('holds a replaced pin for the next tool result when its record cannot be written', async () => {
        observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey() }], opts());
        mkdirSync(join(keyChangesPath(trustPath), 'in-the-way'), { recursive: true });
        const after = await newKey();

        const seen = observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: after, nickname: 'iPhone' }], opts());

        expect(seen).toEqual({ pinned: [], replaced: ['dev_phone'], skipped: [], status: 'ok' });
        expect(read().devices.dev_phone.publicKey).toBe(after);
        expect(warned).toEqual([
            'trust: could not save that key change for later (key-changes.json) — the next tool result notes it',
            'trust: dev_phone changed its key — now pinned to the new one',
        ]);
        rmSync(keyChangesPath(trustPath), { recursive: true });
        expect(takeKeyChanges(trustPath)).toEqual([{ deviceId: 'dev_phone', at: AT.toISOString(), name: 'iPhone' }]);
    });

    // The pin is shared: a process that finds the new key already pinned sees nothing changed, and the record is all that is left.
    it('keeps the record when another process then sees the new key as the pinned one', async () => {
        const reinstalled = await newKey();
        observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey() }], opts());
        observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: reinstalled }], opts());

        observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: reinstalled }], opts());

        expect(takeKeyChanges(trustPath).map((c) => c.deviceId)).toEqual(['dev_phone']);
    });

    it('keeps the listener\'s numbers and unknown fields, carries a replaced key\'s number to commandKeys, and drops sealedOnce', async () => {
        const [before, after, other] = [await newKey(), await newKey(), await newKey()];
        const otherSender = publicKeySender(other)!;
        write({
            version: 1,
            sealedOnce: true,
            devices: { dev_listener: { publicKey: before, pinnedAt: OLD } },
            commands: { dev_listener: 7, dev_gone: 3 },
            commandKeys: { [otherSender]: 9 },
            later: { kept: true },
        });

        observeDevices(trustPath, [{ deviceId: 'dev_listener', publicKey: after }], opts());

        expect(read()).toEqual({
            version: 1,
            devices: { dev_listener: { publicKey: after, pinnedAt: AT.toISOString() } },
            commands: { dev_listener: 7, dev_gone: 3 },
            commandKeys: { [otherSender]: 9, [publicKeySender(before)!]: 7 },
            later: { kept: true },
        });
    });

    it('never lowers a number commandKeys already holds for the replaced key', async () => {
        const [before, after] = [await newKey(), await newKey()];
        write({ version: 1, devices: { dev_listener: { publicKey: before, pinnedAt: OLD } }, commands: { dev_listener: 4 }, commandKeys: { [publicKeySender(before)!]: 12 } });

        observeDevices(trustPath, [{ deviceId: 'dev_listener', publicKey: after }], opts());

        expect(read().commandKeys).toEqual({ [publicKeySender(before)!]: 12 });
    });

    it('does not pin a key already pinned for another id', async () => {
        const phone = await newKey();
        write({ version: 1, devices: { dev_phone: { publicKey: phone, pinnedAt: OLD } } });

        expect(observeDevices(trustPath, [{ deviceId: 'dev_twin', publicKey: phone }], opts())).toEqual({ pinned: [], replaced: [], skipped: ['dev_twin'], status: 'ok' });
        expect(Object.keys(read().devices)).toEqual(['dev_phone']);
    });

    it(`pins no new device past ${MAX_PINNED_DEVICES}, but still follows a changed key`, async () => {
        const keys = await Promise.all(Array.from({ length: MAX_PINNED_DEVICES }, () => newKey()));
        write({ version: 1, devices: Object.fromEntries(keys.map((publicKey, i) => [`dev_${i}`, { publicKey, pinnedAt: OLD }])) });
        const changed = await newKey();

        const seen = observeDevices(trustPath, [{ deviceId: 'dev_new', publicKey: await newKey() }, { deviceId: 'dev_0', publicKey: changed }], opts());

        expect(seen).toEqual({ pinned: [], replaced: ['dev_0'], skipped: ['dev_new'], status: 'ok' });
        expect(Object.keys(read().devices)).toHaveLength(MAX_PINNED_DEVICES);
        expect(read().devices.dev_0!.publicKey).toBe(changed);
    });

    it('reads a file with or without sealedOnce', async () => {
        const phone = await newKey();
        for (const extra of [{}, { sealedOnce: false }, { sealedOnce: 'yes' }]) {
            write({ version: 1, ...extra, devices: {} });
            expect(observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: phone }], opts()).pinned).toEqual(['dev_phone']);
        }
    });

    it.each([
        ['not JSON', '{ not json'],
        ['an unknown version', JSON.stringify({ version: 99, devices: {} })],
        ['no devices', JSON.stringify({ version: 1 })],
        ['a pin with no pinnedAt', JSON.stringify({ version: 1, devices: { dev_phone: { publicKey: 'k' } } })],
        ['a command number that is not a whole number', JSON.stringify({ version: 1, devices: {}, commands: { dev_phone: 1.5 } })],
    ])('warns once and leaves a file with %s as it is', async (_name, text) => {
        writeFileSync(trustPath, text);

        expect(observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey() }], opts())).toEqual({ pinned: [], replaced: [], skipped: [], status: 'unreadable' });
        expect(readFileSync(trustPath, 'utf8')).toBe(text);
        expect(warned).toEqual(['trust: the trust file is unreadable — pins not checked']);
    });

    it('warns about an unreadable file once per process, not on every send', async () => {
        writeFileSync(trustPath, '{ not json');
        const warn = (line: string) => { warned.push(line); };

        observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey() }], { ...opts(), warn });
        observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey() }], { ...opts(), warn });

        expect(warned).toEqual(['trust: the trust file is unreadable — pins not checked']);
    });

    it('reads only its own entries for an id named like an Object.prototype member', async () => {
        const [proto, ctor, before, after] = [await newKey(), await newKey(), await newKey(), await newKey()];
        write({ version: 1, devices: { toString: { publicKey: before, pinnedAt: OLD } }, commands: { toString: 5 } });

        const seen = observeDevices(trustPath, [
            { deviceId: '__proto__', publicKey: proto },
            { deviceId: 'constructor', publicKey: ctor },
            { deviceId: 'toString', publicKey: after },
        ], opts());

        expect(seen).toEqual({ pinned: ['__proto__', 'constructor'], replaced: ['toString'], skipped: [], status: 'ok' });
        const devices = read().devices;
        expect(Object.hasOwn(devices, '__proto__') && devices['__proto__']).toEqual({ publicKey: proto, pinnedAt: AT.toISOString() });
        expect(devices.constructor).toEqual({ publicKey: ctor, pinnedAt: AT.toISOString() });
        expect(read().commandKeys).toEqual({ [publicKeySender(before)!]: 5 });
    });

    it('skips the pin, and writes nothing, while another process holds the lock', async () => {
        writeFileSync(lockPath, '1 1');
        const start = Date.now();
        expect(observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey() }], opts()).status).toBe('unlocked');
        expect(Date.now() - start).toBeGreaterThanOrEqual(1_000);
        expect(existsSync(trustPath)).toBe(false);
        expect(readFileSync(lockPath, 'utf8')).toBe('1 1');
    });

    it('still says a key changed, and holds it for the next tool result, when another process holds the lock', async () => {
        observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey() }], opts());
        const before = readFileSync(trustPath, 'utf8');
        warned = [];
        writeFileSync(lockPath, '1 1');

        const seen = observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey(), nickname: 'iPhone' }], opts());

        expect(seen).toEqual({ pinned: [], replaced: ['dev_phone'], skipped: [], status: 'unlocked' });
        expect(readFileSync(trustPath, 'utf8')).toBe(before);
        expect(warned).toEqual(['trust: dev_phone changed its key — could not record the new pin']);
        expect(existsSync(keyChangesPath(trustPath))).toBe(false);
        expect(takeKeyChanges(trustPath)).toEqual([{ deviceId: 'dev_phone', at: AT.toISOString(), name: 'iPhone' }]);
    }, 10_000);

    it('breaks a lock left by a process that died more than 10 seconds ago', async () => {
        writeFileSync(lockPath, '1 1');
        const old = new Date(Date.now() - 11_000);
        utimesSync(lockPath, old, old);

        expect(observeDevices(trustPath, [{ deviceId: 'dev_phone', publicKey: await newKey() }], opts()).pinned).toEqual(['dev_phone']);
        expect(existsSync(lockPath)).toBe(false);
    });
});

describe('withTrustLock', () => {
    it('holds trusted-devices.lock with this pid while it runs, and removes it after, even on a throw', () => {
        const inside = withTrustLock(trustPath, () => readFileSync(lockPath, 'utf8'));
        expect(inside.locked && inside.value).toMatch(new RegExp(`^${process.pid} \\d+\\n$`));
        expect(existsSync(lockPath)).toBe(false);

        expect(() => withTrustLock(trustPath, () => { throw new Error('boom'); })).toThrow('boom');
        expect(existsSync(lockPath)).toBe(false);
    });

    it('gives up after the wait without running', () => {
        writeFileSync(lockPath, '1 1');
        const fn = vi.fn();
        expect(withTrustLock(trustPath, fn, { waitMs: 50 })).toEqual({ locked: false });
        expect(fn).not.toHaveBeenCalled();
    });
});
