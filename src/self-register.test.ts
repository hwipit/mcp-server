import { describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';
import { ApiError, type HwipApiClient } from './api-client.js';
import { ensureSelfListed, registerOverClient, registerWhyText, unregisteredText, type RegisterWhy } from './self-register.js';

/** A real P-256 SPKI: `samePublicKey` reads the key, not the text. */
const newKey = async (): Promise<string> => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  return Buffer.from(new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))).toString('base64');
};

const SELF_ID = 'dev_listener_0a1b2c3d';

describe('ensureSelfListed', () => {
  it('leaves a list that holds this machine under its key as it is, and registers nothing', async () => {
    const self = { deviceId: SELF_ID, publicKey: await newKey() };
    const devices = [{ ...self, type: 'cli' }, { deviceId: 'dev_phone', type: 'ios' }];
    const register = vi.fn(async () => null);

    expect(await ensureSelfListed(devices, self, register)).toEqual({ ok: true, devices });
    expect(register).not.toHaveBeenCalled();
  });

  it('registers a machine missing from the list once, and adds it as the server made it', async () => {
    const self = { deviceId: SELF_ID, publicKey: await newKey() };
    const phone = { deviceId: 'dev_phone', type: 'ios' };
    const register = vi.fn(async () => null);

    expect(await ensureSelfListed([phone], self, register)).toEqual({ ok: true, devices: [phone, { ...self, type: 'cli' }] });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(self);
  });

  it('registers a machine listed under another key, and keeps the rest of its entry', async () => {
    const self = { deviceId: SELF_ID, publicKey: await newKey() };
    const stale = { deviceId: SELF_ID, publicKey: await newKey(), type: 'cli', nickname: 'desk' };
    const register = vi.fn(async () => null);

    expect(await ensureSelfListed([stale], self, register)).toEqual({ ok: true, devices: [{ ...stale, publicKey: self.publicKey }] });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it.each(['http 404', 'http 400', 'http 401', 'network', 'timeout'] as const)('says why when registering fails: %s', async (why) => {
    const self = { deviceId: SELF_ID, publicKey: await newKey() };

    expect(await ensureSelfListed([], self, async () => why)).toEqual({ ok: false, why });
  });

  // The server lets only a push:read key replace a listed key; an empty slot any of the three scopes may fill.
  it('names a 403 on replacing a listed key apart from a 403 on a missing one', async () => {
    const self = { deviceId: SELF_ID, publicKey: await newKey() };
    const stale = { deviceId: SELF_ID, publicKey: await newKey() };

    expect(await ensureSelfListed([stale], self, async () => 'http 403')).toEqual({ ok: false, why: 'replace-forbidden' });
    expect(await ensureSelfListed([], self, async () => 'http 403')).toEqual({ ok: false, why: 'http 403' });
  });
});

describe('registerOverClient', () => {
  const clientDoing = (registerDeviceKey: HwipApiClient['registerDeviceKey']) => ({ registerDeviceKey: vi.fn(registerDeviceKey) });

  it('PUTs this machine\'s key and its host name under its id', async () => {
    const client = clientDoing(async () => ({ data: {} }) as never);
    const publicKey = await newKey();

    expect(await registerOverClient(client)({ deviceId: SELF_ID, publicKey })).toBeNull();

    expect(client.registerDeviceKey).toHaveBeenCalledTimes(1);
    expect(client.registerDeviceKey).toHaveBeenCalledWith(SELF_ID, publicKey, hostname() || 'listener');
  });

  it.each([
    [new ApiError('not found', 'NOT_FOUND', 404), 'http 404'],
    [new ApiError('forbidden', 'FORBIDDEN', 403), 'http 403'],
    [new ApiError('bad id', 'VALIDATION_ERROR', 400), 'http 400'],
    [new ApiError('down', 'INTERNAL_ERROR', 500), 'http 500'],
    [new ApiError('slow', 'API_TIMEOUT', 408), 'timeout'],
    [new ApiError('unreachable', 'NETWORK_ERROR', 0), 'network'],
    [new ApiError('moved', 'REDIRECT_REFUSED', 0), 'network'],
    [new TypeError('fetch failed'), 'network'],
  ] as const)('reads %s as %s', async (err, why) => {
    const client = clientDoing(async () => { throw err; });

    expect(await registerOverClient(client)({ deviceId: SELF_ID, publicKey: await newKey() })).toBe(why);
  });
});

describe('what a person reads', () => {
  it.each([
    ['http 404', 'the server answered HTTP 404'],
    ['network', 'could not reach the server'],
    ['timeout', 'the server did not answer in time'],
    ['replace-forbidden', 'the account lists another key for it, and only an API key with push:read may replace it'],
  ] as const)('%s', (why: RegisterWhy, text) => {
    expect(registerWhyText(why)).toBe(text);
  });

  it('names what was not sent, and no listener', () => {
    expect(unregisteredText('question', 'network')).toBe('could not register this machine\'s key in the account\'s device list (could not reach the server); the question was not sent');
    expect(unregisteredText('message')).not.toMatch(/listener/);
  });
});
