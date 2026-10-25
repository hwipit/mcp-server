import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./crypto.js', () => ({
    getKeyPair: vi.fn(() => null),
    getPublicKey: vi.fn(() => null),
    selectRecipients: vi.fn((devices: { deviceId: string; publicKey?: string }[]) =>
        devices.filter((d) => !!d.publicKey).map(({ deviceId, publicKey }) => ({ deviceId, publicKey })),
    ),
    samePublicKey: vi.fn((a: string, b: string) => a === b),
    publicKeySender: vi.fn((key: string) => `x_${key}`),
    cryptoReady: vi.fn(async () => undefined),
}));

import { APP_LOGIN_REQUIRED, hasAppDevice, resolveAudience } from './push-audience.js';
import { ApiError, type HwipApiClient } from './api-client.js';
import { cryptoReady, getKeyPair, getPublicKey } from './crypto.js';

type Device = { deviceId: string; publicKey?: string; type?: string };

const withKeys = () => {
    vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
    vi.mocked(getPublicKey).mockReturnValue('my-public-key');
};

const clientWith = (devices: Device[], registerDeviceKey = vi.fn(async (): Promise<unknown> => ({ data: {} }))) =>
    ({ listDevices: vi.fn(async () => ({ data: devices })), registerDeviceKey } as unknown as HwipApiClient & { registerDeviceKey: typeof registerDeviceKey });

const failing = (err: Error) => ({ listDevices: vi.fn(async () => { throw err; }) } as unknown as HwipApiClient);

const trustFile = (pins: Record<string, string> = {}): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'hwip-trust-')), 'trusted-devices.json');
    const devices = Object.fromEntries(Object.entries(pins).map(([id, publicKey]) => [id, { publicKey, pinnedAt: '2026-10-11T00:00:00Z' }]));
    writeFileSync(path, JSON.stringify({ version: 1, devices }));
    return path;
};

/** No trust file yet: a fresh folder per test, where the first send pins. */
let NONE: string;

const PHONE: Device = { deviceId: 'dev_phone', publicKey: 'pub_phone', type: 'ios' };

beforeEach(() => {
    NONE = join(mkdtempSync(join(tmpdir(), 'hwip-trust-')), 'trusted-devices.json');
    vi.clearAllMocks();
    vi.mocked(getKeyPair).mockReturnValue(null);
    vi.mocked(getPublicKey).mockReturnValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('hasAppDevice', () => {
    it('counts only the iPhone and Android apps', () => {
        expect(hasAppDevice([{ type: 'ios' }])).toBe(true);
        expect(hasAppDevice([{ type: 'android' }])).toBe(true);
        expect(hasAppDevice([{ type: 'macos' }, { type: 'cli' }, { type: 'chrome_extension' }, {}])).toBe(false);
        expect(hasAppDevice([])).toBe(false);
    });
});

describe('resolveAudience', () => {
    it('waits for crypto to start before deciding', async () => {
        let started!: () => void;
        vi.mocked(cryptoReady).mockReturnValueOnce(new Promise<void>((resolve) => (started = () => { withKeys(); resolve(); })));
        const audience = resolveAudience(clientWith([PHONE]), { trustPath: NONE });
        started();
        expect(await audience).toEqual({ recipients: [{ deviceId: 'dev_phone', publicKey: 'pub_phone' }] });
    });

    it('seals for every device that carries a public key', async () => {
        withKeys();
        const devices = [PHONE, { deviceId: 'dev_pc', publicKey: 'pub_pc', type: 'cli' }, { deviceId: 'dev_old', type: 'android' }];

        expect(await resolveAudience(clientWith(devices), { trustPath: NONE })).toEqual({
            recipients: [{ deviceId: 'dev_phone', publicKey: 'pub_phone' }, { deviceId: 'dev_pc', publicKey: 'pub_pc' }],
        });
    });

    it('refuses without listing devices when this machine has no keys', async () => {
        const client = clientWith([PHONE]);

        expect(await resolveAudience(client, { trustPath: NONE })).toEqual({ refused: expect.stringContaining('keys did not load'), code: 'E2E_REQUIRED' });
        expect(client.listDevices).not.toHaveBeenCalled();
    });

    it.each([
        ['a timeout', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
        ['a 5xx', Object.assign(new Error('Internal Server Error'), { status: 503 })],
        ['a refused connection', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })],
    ])('refuses when the device list fails with %s', async (_, err) => {
        withKeys();

        expect(await resolveAudience(failing(err), { trustPath: NONE }))
            .toEqual({ refused: 'the device list could not be read; nothing was sent', code: 'E2E_REQUIRED' });
    });

    it('refuses when the device list is not a list', async () => {
        withKeys();
        const client = { listDevices: vi.fn(async () => ({ data: { nope: true } })) } as unknown as HwipApiClient;

        expect(await resolveAudience(client, { trustPath: NONE })).toEqual({ refused: expect.stringContaining('device list'), code: 'E2E_REQUIRED' });
    });

    it('refuses with the app sign-in line when no iPhone or Android app is listed', async () => {
        withKeys();
        const devices = [{ deviceId: 'dev_pc', publicKey: 'pub_pc', type: 'cli' }, { deviceId: 'dev_mac', publicKey: 'pub_mac', type: 'macos' }];

        expect(await resolveAudience(clientWith(devices), { trustPath: NONE })).toEqual({ refused: APP_LOGIN_REQUIRED, code: 'NO_APP_DEVICE' });
        expect(APP_LOGIN_REQUIRED).toBe('sign in to the Hwip app on an iPhone or Android phone');
    });

    it('refuses when the app is listed but no device has a key', async () => {
        withKeys();

        expect(await resolveAudience(clientWith([{ deviceId: 'dev_phone', type: 'ios' }]), { trustPath: NONE }))
            .toEqual({ refused: expect.stringContaining('no device has a per-device public key'), code: 'E2E_REQUIRED' });
    });

    it('seals for every listed device with a key whatever is pinned, pins the new ones and follows a changed key', async () => {
        withKeys();
        const devices = [PHONE, { deviceId: 'dev_swapped', publicKey: 'pub_new', type: 'ios' }, { deviceId: 'dev_pc', publicKey: 'pub_pc', type: 'cli' }];
        const path = trustFile({ dev_swapped: 'pub_old', dev_elsewhere: 'pub_elsewhere' });

        const audience = await resolveAudience(clientWith(devices), { trustPath: path, selfId: 'dev_pc' });

        expect(audience).toEqual({ recipients: devices.map(({ deviceId, publicKey }) => ({ deviceId, publicKey })) });
        const pins = JSON.parse(readFileSync(path, 'utf8')).devices as Record<string, { publicKey: string }>;
        expect(Object.fromEntries(Object.entries(pins).map(([id, pin]) => [id, pin.publicKey])))
            .toEqual({ dev_swapped: 'pub_new', dev_elsewhere: 'pub_elsewhere', dev_phone: 'pub_phone' });
        expect(console.error).toHaveBeenCalledWith('[hwip] trust: dev_swapped changed its key — now pinned to the new one');
    });

    it('does not register this machine when the list holds it under its key', async () => {
        withKeys();
        const client = clientWith([PHONE, { deviceId: 'dev_pc', publicKey: 'my-public-key', type: 'cli' }]);

        await resolveAudience(client, { trustPath: NONE, selfId: 'dev_pc' });

        expect(client.registerDeviceKey).not.toHaveBeenCalled();
    });

    it('registers this machine once when the list lacks it, and seals for the list as it was read', async () => {
        withKeys();
        const client = clientWith([PHONE]);

        expect(await resolveAudience(client, { trustPath: NONE, selfId: 'dev_pc' }))
            .toEqual({ recipients: [{ deviceId: 'dev_phone', publicKey: 'pub_phone' }] });
        expect(client.registerDeviceKey).toHaveBeenCalledTimes(1);
        expect(client.registerDeviceKey).toHaveBeenCalledWith('dev_pc', 'my-public-key', expect.any(String));
        expect(client.listDevices).toHaveBeenCalledTimes(1);
        expect(console.error).not.toHaveBeenCalled();
    });

    it.each([
        ['the server has no such route yet', [PHONE], new ApiError('not found', 'NOT_FOUND', 404), 'the server answered HTTP 404'],
        ['the server cannot be reached', [PHONE], new ApiError('unreachable', 'NETWORK_ERROR', 0), 'could not reach the server'],
        ['the server does not answer', [PHONE], new ApiError('slow', 'API_TIMEOUT', 408), 'the server did not answer in time'],
        ['the API key may not replace the listed key', [PHONE, { deviceId: 'dev_pc', publicKey: 'old-key', type: 'cli' }], new ApiError('forbidden', 'FORBIDDEN', 403),
            'the account lists another key for it, and only an API key with device:write and push:read may replace it'],
    ] as const)('still seals, with one line on stderr, when registering fails: %s', async (_name, devices, err, why) => {
        withKeys();
        const client = clientWith([...devices], vi.fn(async (): Promise<unknown> => { throw err; }));

        const audience = await resolveAudience(client, { trustPath: NONE, selfId: 'dev_pc' });

        expect('recipients' in audience).toBe(true);
        expect(console.error).toHaveBeenCalledWith(`[hwip] could not register this machine's key (${why}) — the app cannot verify who sent this push`);
    });

    it('does not register when no app is listed', async () => {
        withKeys();
        const client = clientWith([{ deviceId: 'dev_mac', publicKey: 'pub_mac', type: 'macos' }]);

        await resolveAudience(client, { trustPath: NONE, selfId: 'dev_pc' });

        expect(client.registerDeviceKey).not.toHaveBeenCalled();
    });

    it('still seals when the trust file cannot be read, with one warning, and leaves it as it is', async () => {
        withKeys();
        const path = join(mkdtempSync(join(tmpdir(), 'hwip-trust-')), 'trusted-devices.json');
        writeFileSync(path, '{ not json');

        expect(await resolveAudience(clientWith([PHONE]), { trustPath: path, selfId: 'dev_pc' }))
            .toEqual({ recipients: [{ deviceId: 'dev_phone', publicKey: 'pub_phone' }] });
        expect(readFileSync(path, 'utf8')).toBe('{ not json');
        expect(console.error).toHaveBeenCalledWith('[hwip] trust: the trust file is unreadable — pins not checked');
    });
});
