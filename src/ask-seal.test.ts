import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from './api-client.js';
import type { AskSealDeps, SealedFields } from './ask-seal.js';
import type { PushBodyInput } from './crypto.js';

// Real keys and real envelopes: this machine is the vectors file's `sender`, the phone its
// `recipient`, and `stranger` is some other device. The phone's side is written out here with
// WebCrypto so the asker is checked against the wire format and not against its own idea of it.

const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };
interface KeyPair { publicKey: string; privateKey: string }
const KEYS = (JSON.parse(readFileSync(new URL('./crypto-labels.vectors.json', import.meta.url), 'utf8')) as {
  keys: { sender: KeyPair; recipient: KeyPair; stranger: KeyPair };
}).keys; // own fixture file
const ASKER = KEYS.sender;
const PHONE = KEYS.recipient;
const STRANGER = KEYS.stranger;

const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');
const b64 = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64');

/** What a device with `from`'s key seals for the given `to` public keys (deviceId → key). */
const sealAs = async (from: KeyPair, content: PushBodyInput, to: Record<string, string>): Promise<SealedFields> => {
  const privateKey = await crypto.subtle.importKey('pkcs8', unb64(from.privateKey), ECDH, false, ['deriveKey']);
  const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, messageKey, new TextEncoder().encode(JSON.stringify(content)));
  const raw = await crypto.subtle.exportKey('raw', messageKey);
  const deviceKeyMap: Record<string, string> = {};
  for (const [deviceId, publicKey] of Object.entries(to)) {
    const shared = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: await crypto.subtle.importKey('spki', unb64(publicKey), ECDH, false, []) },
      privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
    );
    const keyIv = crypto.getRandomValues(new Uint8Array(12));
    deviceKeyMap[deviceId] = JSON.stringify({ encryptedKey: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, shared, raw)), keyIv: b64(keyIv) });
  }
  return { body: JSON.stringify({ ciphertext: b64(ciphertext), iv: b64(iv) }), senderPublicKey: from.publicKey, deviceKeyMap };
};

let TMP: string;
let trustPath: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'ask-seal-'));
  trustPath = join(TMP, 'trusted-devices.json');
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

const pinFile = (devices: Record<string, string>): void => {
  const pins = Object.fromEntries(Object.entries(devices).map(([id, publicKey]) => [id, { publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' }]));
  writeFileSync(trustPath, JSON.stringify({ version: 1, devices: pins }));
};
const pinnedKeys = (): Record<string, string> =>
  Object.fromEntries(Object.entries(JSON.parse(readFileSync(trustPath, 'utf8')).devices as Record<string, { publicKey: string }>).map(([id, pin]) => [id, pin.publicKey]));

/** A fresh module graph whose device key is `keys`, as if this host were that device. */
const asDevice = async (keys: KeyPair): Promise<{ crypto: typeof import('./crypto.js'); seal: typeof import('./ask-seal.js') }> => {
  const home = mkdtempSync(join(TMP, 'home-'));
  mkdirSync(join(home, '.hwip'), { recursive: true });
  writeFileSync(join(home, '.hwip', 'device-keys.json'), JSON.stringify(keys));
  process.env.HOME = home;
  vi.resetModules();
  const cryptoMod = await import('./crypto.js');
  await cryptoMod.initCrypto();
  return { crypto: cryptoMod, seal: await import('./ask-seal.js') };
};

const LISTED = [
  { deviceId: 'dev_laptop', publicKey: ASKER.publicKey, type: 'cli' },
  { deviceId: 'dev_phone', publicKey: PHONE.publicKey, type: 'ios' },
];
const ACTIONS = [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }];
const QUESTION = { title: 'Deploy to production?', body: 'All checks are green.', actions: ACTIONS };

const depsFor = (overrides: Partial<AskSealDeps> = {}): AskSealDeps => ({
  loadKeys: async () => undefined,
  self: () => ({ deviceId: 'dev_laptop', publicKey: ASKER.publicKey }),
  listDevices: async () => LISTED,
  // A server without the route yet: what a test that lists this machine nowhere meets.
  register: async () => 'http 404',
  trustPath,
  newAskId: () => 'q7Zk2mV0wXb9Yc3dEfGhIg',
  ...overrides,
});

describe('prepareAsk', () => {
  // F16: no phone app, no question — nothing is sealed for the other computers instead.
  it('refuses with the app sign-in line when no iPhone or Android app is listed', async () => {
    const { seal } = await asDevice(ASKER);
    const sealer = vi.fn();
    const computers = [LISTED[0]!, { deviceId: 'dev_mac', publicKey: STRANGER.publicKey, type: 'macos' }, { deviceId: 'dev_pc', publicKey: PHONE.publicKey, type: 'cli' }];
    expect(await seal.prepareAsk(QUESTION, depsFor({ listDevices: async () => computers, seal: sealer }))).toEqual({ kind: 'refused', cause: 'no-app' });
    expect(sealer).not.toHaveBeenCalled();
    expect(seal.refusalMessage('no-app')).toBe('sealed ask: no app is signed in to this account: sign in to the Hwip app on an iPhone or Android phone, then send again; the question was not sent');
  });

  it.each([
    ['a label over 100 characters', [{ id: 'go', label: 'y'.repeat(101) }]],
    ['an id over 64 characters', [{ id: 'x'.repeat(65), label: 'Go' }]],
    ['eleven choices', Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, label: `A${i}` }))],
  ])('says a question with %s is too large', async (_name, actions) => {
    const { seal } = await asDevice(ASKER);
    // The real seal: the code this relies on is crypto.ts's.
    expect(await seal.prepareAsk({ ...QUESTION, actions }, depsFor())).toEqual({ kind: 'refused', cause: 'too-large' });
  });

  it('still calls any other sealing failure a failure', async () => {
    const { seal } = await asDevice(ASKER);
    const broken = depsFor({ seal: async () => { throw new Error('boom'); } });
    expect(await seal.prepareAsk(QUESTION, broken)).toEqual({ kind: 'refused', cause: 'encrypt' });
  });

  it('seals the question for the other devices; the phone opens it and finds the wording and the ask label', async () => {
    const asker = await asDevice(ASKER);
    const prepared = await asker.seal.prepareAsk(QUESTION, depsFor());

    expect(prepared.kind).toBe('sealed');
    if (prepared.kind !== 'sealed') return;
    expect(prepared.askId).toBe('q7Zk2mV0wXb9Yc3dEfGhIg');
    expect(prepared.offered).toEqual(['approve', 'deny']);
    expect(Object.keys(prepared.fields.deviceKeyMap)).toEqual(['dev_phone']);
    expect(JSON.stringify(prepared.fields)).not.toContain('Deploy');
    expect(JSON.stringify(prepared.fields)).not.toContain('Approve');

    const phone = await asDevice(PHONE);
    const opened = await phone.crypto.decryptPushBodyForDevice(prepared.fields.body, prepared.fields.deviceKeyMap.dev_phone!, prepared.fields.senderPublicKey);
    expect(opened).toMatchObject({
      title: 'Deploy to production?',
      body: 'All checks are green.',
      ask: { id: 'q7Zk2mV0wXb9Yc3dEfGhIg', device: 'dev_laptop', actions: ACTIONS },
    });
  });

  describe('with a context attachment', () => {
    const SUMMARY = {
      diff: 'ok' as const, files: 1, added: 2, removed: 1,
      listed: [{ path: 'src/a.ts', status: 'M' as const, added: 2, removed: 1 }],
      moreFiles: 0, screenLines: 3, masked: 0, cut: { diff: false, screen: false },
    };
    const META = { iv: 'AAECAwQFBgcICQoL', name: 'ask-context.json', type: 'application/vnd.hwip.ask-context+json', size: 321 };
    const FILE = { fileKey: 'files/1', fileName: 'file', fileType: 'application/octet-stream', fileSize: 65536, iv: META.iv, deviceKeyMap: { dev_phone: 'wrapped' } };
    const openAsPhone = async (fields: SealedFields) => {
      const phone = await asDevice(PHONE);
      return phone.crypto.decryptPushBodyForDevice(fields.body, fields.deviceKeyMap.dev_phone!, fields.senderPublicKey);
    };

    it.each([
      ['the device list cannot be read', { listDevices: async () => { throw new Error('devices 503'); } }, 'refused'],
      ['the keys do not load', { loadKeys: async () => { throw new Error('locked'); } }, 'refused'],
      ['there is nobody to seal for', { listDevices: async () => [LISTED[0]!] }, 'refused'],
    ])('gathers nothing when %s', async (_name, overrides, kind) => {
      const { seal } = await asDevice(ASKER);
      const attach = vi.fn(async () => ({ context: SUMMARY, meta: META, file: FILE }));
      const prepared = await seal.prepareAsk(QUESTION, depsFor({ ...overrides, attach }));
      expect(prepared.kind).toBe(kind);
      expect(attach).not.toHaveBeenCalled();
    });

    it('seals the summary and the name of the original into the body, for the same devices, and hands the attachment on', async () => {
      const asker = await asDevice(ASKER);
      const attach = vi.fn(async () => ({ context: SUMMARY, meta: META, file: FILE }));
      const prepared = await asker.seal.prepareAsk(QUESTION, depsFor({ attach }));

      if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
      expect(attach).toHaveBeenCalledWith([{ deviceId: 'dev_phone', publicKey: PHONE.publicKey }]);
      expect(prepared.files).toEqual([FILE]);
      const opened = await openAsPhone(prepared.fields);
      expect(opened).toMatchObject({ title: 'Deploy to production?', ask: { id: 'q7Zk2mV0wXb9Yc3dEfGhIg' }, files: [META], context: SUMMARY });
    });

    it('names the attachment and no summary when there was no context', async () => {
      const asker = await asDevice(ASKER);
      const prepared = await asker.seal.prepareAsk(QUESTION, depsFor({ attach: async () => ({ meta: { ...META, size: 0 }, file: FILE }) }));

      if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
      expect(prepared.files).toEqual([FILE]);
      const opened = await openAsPhone(prepared.fields);
      expect(opened.files).toEqual([{ ...META, size: 0 }]);
      expect(opened.context).toBeUndefined();
    });

    it('sends the question without the attachment when attaching fails', async () => {
      const asker = await asDevice(ASKER);
      const prepared = await asker.seal.prepareAsk(QUESTION, depsFor({ attach: async () => { throw new Error('upload 503'); } }));

      if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
      expect(prepared.files).toBeUndefined();
      const opened = await openAsPhone(prepared.fields);
      expect(opened.title).toBe('Deploy to production?');
      expect(opened.files).toBeUndefined();
      expect(opened.context).toBeUndefined();
    });

    it('leaves the attachment out too when the summary alone was not enough', async () => {
      const asker = await asDevice(ASKER);
      const attach = async () => ({ context: SUMMARY, meta: META, file: FILE });
      const bare = await asker.seal.prepareAsk({ ...QUESTION, body: 'x'.repeat(35_000) }, depsFor());
      if (bare.kind !== 'sealed') throw new Error('expected a sealed question');
      // A body that fits on its own, with less room left than the attachment's name takes.
      const room = 48 * 1024 - Buffer.byteLength(bare.fields.body);
      const longer = 'x'.repeat(35_000 + Math.floor(room * 3 / 4) - 8);

      const prepared = await asker.seal.prepareAsk({ ...QUESTION, body: longer }, depsFor({ attach }));

      if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
      expect(Buffer.byteLength(prepared.fields.body)).toBeLessThanOrEqual(48 * 1024);
      expect(prepared.files).toBeUndefined();
      const opened = await openAsPhone(prepared.fields);
      expect(opened.body).toBe(longer);
      expect(opened.files).toBeUndefined();
    });

    it('leaves the summary out when it would push the envelope over what the server takes for a question', async () => {
      const asker = await asDevice(ASKER);
      const attach = async () => ({ context: SUMMARY, meta: META, file: FILE });
      // Base64 of the plaintext: the summary is what tips this body over 48 KiB.
      const summaryBytes = Buffer.byteLength(JSON.stringify(SUMMARY));
      const fits = await asker.seal.prepareAsk({ ...QUESTION, body: 'x'.repeat(35_000) }, depsFor({ attach }));
      if (fits.kind !== 'sealed') throw new Error('expected a sealed question');
      const room = 48 * 1024 - Buffer.byteLength(fits.fields.body);
      expect(room).toBeGreaterThan(0);
      const longer = 'x'.repeat(35_000 + Math.floor(room * 3 / 4) + 3);
      expect(summaryBytes).toBeGreaterThan(3);

      const prepared = await asker.seal.prepareAsk({ ...QUESTION, body: longer }, depsFor({ attach }));

      if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
      expect(Buffer.byteLength(prepared.fields.body)).toBeLessThanOrEqual(48 * 1024);
      expect(prepared.files).toEqual([FILE]);
      const opened = await openAsPhone(prepared.fields);
      expect(opened.body).toBe(longer);
      expect(opened.files).toEqual([META]);
      expect(opened.context).toBeUndefined();
    });
  });

  it('makes a fresh 128-bit id for every question', async () => {
    const { seal } = await asDevice(ASKER);
    const deps = depsFor({ newAskId: undefined });
    const first = await seal.prepareAsk(QUESTION, deps);
    const second = await seal.prepareAsk(QUESTION, deps);
    if (first.kind !== 'sealed' || second.kind !== 'sealed') throw new Error('expected sealed questions');
    expect(first.askId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.askId).not.toBe(second.askId);
  });

  it.each([
    ['keys do not load', { loadKeys: async () => { throw new Error('keychain locked'); } }, 'keystore'],
    ['this machine has no key', { self: () => null }, 'keystore'],
    ['the device list cannot be fetched', { listDevices: async () => { throw new Error('devices 503'); } }, 'devices'],
    ['there is no phone app', { listDevices: async () => [LISTED[0]!] }, 'no-app'],
    ['the phone app has no key', { listDevices: async () => [LISTED[0]!, { deviceId: 'dev_phone', type: 'android' }] }, 'no-recipients'],
    ['sealing throws', { seal: async () => { throw new Error('boom'); } }, 'encrypt'],
  ] as const)('refuses, and never falls back to plaintext, when %s', async (_name, override, cause) => {
    const { seal } = await asDevice(ASKER);
    expect(await seal.prepareAsk(QUESTION, depsFor(override))).toEqual({ kind: 'refused', cause });
  });

  // M41: a list failure that is really the configuration is not a transient fetch problem.
  it.each([
    ['an address that is not one', new ApiError('Could not reach the hwip API (ERR_INVALID_URL).', 'NETWORK_ERROR', 0, { unsent: true, causeCode: 'ERR_INVALID_URL' })],
    ['a refused key', new ApiError('bad key', 'UNAUTHORIZED', 401)],
  ])('throws the configuration on when the list fails with %s, instead of a devices refusal', async (_name, failure) => {
    const { seal } = await asDevice(ASKER);
    await expect(seal.prepareAsk(QUESTION, depsFor({ listDevices: async () => { throw failure; } }))).rejects.toBe(failure);
  });

  it('does not register this machine when the list holds it under its key', async () => {
    const { seal } = await asDevice(ASKER);
    const register = vi.fn(async () => null);

    expect((await seal.prepareAsk(QUESTION, depsFor({ register }))).kind).toBe('sealed');
    expect(register).not.toHaveBeenCalled();
  });

  it.each([
    ['missing from the list', [LISTED[1]!]],
    ['listed under another key', [{ deviceId: 'dev_laptop', publicKey: STRANGER.publicKey, type: 'cli' }, LISTED[1]!]],
  ])('puts this machine\'s key on the list once when it is %s, then seals, without reading the list again', async (_name, devices) => {
    const { seal } = await asDevice(ASKER);
    const register = vi.fn(async () => null);
    const listDevices = vi.fn(async () => devices);

    expect((await seal.prepareAsk(QUESTION, depsFor({ listDevices, register }))).kind).toBe('sealed');
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({ deviceId: 'dev_laptop', publicKey: ASKER.publicKey });
    expect(listDevices).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the server has no such route yet', 'http 404'],
    ['the server cannot be reached', 'network'],
    ['the server does not answer', 'timeout'],
    ['the API key may not write it', 'http 403'],
  ] as const)('refuses, sending nothing, when this machine cannot be registered: %s', async (_name, why) => {
    const { seal } = await asDevice(ASKER);
    const sealIt = vi.fn();

    const prepared = await seal.prepareAsk(QUESTION, depsFor({ listDevices: async () => [LISTED[1]!], register: async () => why, seal: sealIt }));

    expect(prepared).toEqual({ kind: 'refused', cause: 'self-unlisted', why });
    expect(sealIt).not.toHaveBeenCalled();
  });

  // Only a push:read key may replace a listed key: the old one stays, and the app would seal the answer for it.
  it('refuses, saying so, when the list holds another key for this machine and the API key may not replace it', async () => {
    const { seal } = await asDevice(ASKER);
    const listDevices = async () => [{ deviceId: 'dev_laptop', publicKey: STRANGER.publicKey, type: 'cli' }, LISTED[1]!];

    const prepared = await seal.prepareAsk(QUESTION, depsFor({ listDevices, register: async () => 'http 403' }));

    expect(prepared).toEqual({ kind: 'refused', cause: 'self-unlisted', why: 'replace-forbidden' });
    expect(seal.refusalMessage('self-unlisted', 'replace-forbidden')).toBe(
      'sealed ask: could not register this machine\'s key in the account\'s device list (the account lists another key for it, and only an API key with push:read may replace it); the question was not sent',
    );
  });

  it('still seals when the trust file cannot be read, and leaves it as it is', async () => {
    const { seal } = await asDevice(ASKER);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeFileSync(trustPath, '{ not json');
    expect((await seal.prepareAsk(QUESTION, depsFor())).kind).toBe('sealed');
    expect(readFileSync(trustPath, 'utf8')).toBe('{ not json');
  });

  it('seals for every other listed device whatever is pinned, and pins the ones seen first', async () => {
    const asker = await asDevice(ASKER);
    pinFile({ dev_tablet: STRANGER.publicKey });
    const prepared = await asker.seal.prepareAsk(QUESTION, depsFor());
    if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
    expect(Object.keys(prepared.fields.deviceKeyMap)).toEqual(['dev_phone']);
    // This machine is never pinned.
    expect(pinnedKeys()).toEqual({ dev_tablet: STRANGER.publicKey, dev_phone: PHONE.publicKey });
  });

  it('seals for a device whose key changed, and moves its pin with one warning', async () => {
    const asker = await asDevice(ASKER);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pinFile({ dev_phone: STRANGER.publicKey });
    const prepared = await asker.seal.prepareAsk(QUESTION, depsFor());
    if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
    expect(Object.keys(prepared.fields.deviceKeyMap)).toEqual(['dev_phone']);
    expect(pinnedKeys()).toEqual({ dev_phone: PHONE.publicKey });
    expect(warn).toHaveBeenCalledWith('[hwip] trust: dev_phone changed its key — now pinned to the new one');
  });

  it('seals for every other listed device when nothing is pinned', async () => {
    const asker = await asDevice(ASKER);
    const devices = [...LISTED, { deviceId: 'dev_other', publicKey: STRANGER.publicKey }];
    const prepared = await asker.seal.prepareAsk(QUESTION, depsFor({ listDevices: async () => devices }));
    if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
    expect(Object.keys(prepared.fields.deviceKeyMap).sort()).toEqual(['dev_other', 'dev_phone']);
  });
});

describe('openAnswer', () => {
  const ASK_ID = 'q7Zk2mV0wXb9Yc3dEfGhIg';
  const OFFERED = ['approve', 'deny'];
  const toAsker = { dev_laptop: ASKER.publicKey };

  const open = async (response: unknown, overrides: Partial<AskSealDeps> = {}, offered: string[] | undefined = OFFERED) => {
    const { seal } = await asDevice(ASKER);
    return seal.openAnswer(response as never, ASK_ID, offered, depsFor(overrides));
  };
  const answerFrom = async (content: PushBodyInput, from: KeyPair = PHONE, to: Record<string, string> = toAsker) =>
    ({ sealed: await sealAs(from, content, to), respondedDeviceId: 'dev_phone' });

  it('reads a chosen action from a phone seen for the first time, and pins it', async () => {
    const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } });
    expect(await open(response)).toEqual({ ok: true, actionId: 'approve' });
    expect(pinnedKeys()).toEqual({ dev_phone: PHONE.publicKey });
  });

  it('reads the answer of a pinned phone', async () => {
    pinFile({ dev_phone: PHONE.publicKey });
    const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'deny' } });
    expect(await open(response)).toEqual({ ok: true, actionId: 'deny' });
  });

  it('reads typed text with the exit flag', async () => {
    const response = await answerFrom({ body: 'ship it', answer: { ask: ASK_ID, exit: true } });
    expect(await open(response)).toEqual({ ok: true, value: 'ship it', exit: true });
  });

  it('reads typed text alone', async () => {
    const response = await answerFrom({ body: 'run the tests', answer: { ask: ASK_ID } });
    expect(await open(response, {}, undefined)).toEqual({ ok: true, value: 'run the tests' });
  });

  it('ignores plaintext fields in the response: only the seal is read', async () => {
    const response = { ...(await answerFrom({ answer: { ask: ASK_ID, actionId: 'deny' } })), actionId: 'approve', value: 'injected' };
    expect(await open(response)).toEqual({ ok: true, actionId: 'deny' });
  });

  it('refuses a response with no seal, however plain its answer looks', async () => {
    expect(await open({ actionId: 'approve', respondedDeviceId: 'dev_phone' })).toEqual({ ok: false, cause: 'not-sealed' });
    expect(await open(undefined)).toEqual({ ok: false, cause: 'not-sealed' });
    expect(await open({ sealed: { body: 1 }, respondedDeviceId: 'dev_phone' })).toEqual({ ok: false, cause: 'not-sealed' });
  });

  it('refuses an answer that names another question', async () => {
    const response = await answerFrom({ answer: { ask: 'someone-elses-question', actionId: 'approve' } });
    expect(await open(response)).toEqual({ ok: false, cause: 'wrong-labels' });
  });

  it('refuses a body with no answer label — the text alone is not an answer', async () => {
    const response = await answerFrom({ body: 'approve' });
    expect(await open(response)).toEqual({ ok: false, cause: 'wrong-labels' });
  });

  it.each([
    ['an ask label', { ask: { id: ASK_ID, device: 'dev_laptop' } }],
    ['a cmd label', { cmd: { n: 1, session: 's', device: 'dev_laptop' } }],
  ])('refuses an answer that also carries %s', async (_name, extra) => {
    const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' }, ...extra });
    expect(await open(response)).toEqual({ ok: false, cause: 'wrong-labels' });
  });

  it('refuses the question played back as the answer, whoever it claims to come from', async () => {
    const asker = await asDevice(ASKER);
    const prepared = await asker.seal.prepareAsk(QUESTION, depsFor());
    if (prepared.kind !== 'sealed') throw new Error('expected a sealed question');
    for (const [from, cause] of [['dev_laptop', 'no-slot'], ['dev_phone', 'sender-mismatch']] as const) {
      const outcome = await asker.seal.openAnswer({ sealed: prepared.fields, respondedDeviceId: from }, ASK_ID, OFFERED, depsFor());
      expect(outcome).toEqual({ ok: false, cause });
    }
  });

  it('refuses a question envelope that does carry this machine\'s slot, played back as the answer', async () => {
    // Listing this machine under its own key lets it pass the sender check; the labels must still stop it.
    const replay = await sealAs(ASKER, { title: 't', body: 'approve', ask: { id: ASK_ID, device: 'dev_laptop' } }, toAsker);
    const { seal } = await asDevice(ASKER);
    const outcome = await seal.openAnswer({ sealed: replay, respondedDeviceId: 'dev_laptop' }, ASK_ID, OFFERED, depsFor());
    expect(outcome).toEqual({ ok: false, cause: 'wrong-labels' });
  });

  it('refuses an envelope sealed with a key other than the answering device\'s', async () => {
    const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } }, STRANGER);
    expect(await open(response)).toEqual({ ok: false, cause: 'sender-mismatch' });
  });

  it('refuses a device the account does not list', async () => {
    const response = { ...(await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } })), respondedDeviceId: 'dev_ghost' };
    expect(await open(response)).toEqual({ ok: false, cause: 'peer-unlisted' });
  });

  it('reads the answer of a phone whose key changed, and moves its pin with one warning', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pinFile({ dev_phone: STRANGER.publicKey });
    const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } });
    expect(await open(response)).toEqual({ ok: true, actionId: 'approve' });
    expect(pinnedKeys()).toEqual({ dev_phone: PHONE.publicKey });
    expect(warn).toHaveBeenCalledWith('[hwip] trust: dev_phone changed its key — now pinned to the new one');
  });

  it('reads the answer of a phone not pinned while other devices are', async () => {
    pinFile({ dev_tablet: STRANGER.publicKey });
    const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } });
    expect(await open(response)).toEqual({ ok: true, actionId: 'approve' });
  });

  it('looks the answering device up in the account\'s list even when it names this machine', async () => {
    // `peerKeyOf` is asked without `self`: this machine's own key never stands in for a listed one.
    const own = await sealAs(ASKER, { answer: { ask: ASK_ID, actionId: 'approve' } }, toAsker);
    const { seal } = await asDevice(ASKER);
    const outcome = await seal.openAnswer({ sealed: own, respondedDeviceId: 'dev_laptop' }, ASK_ID, OFFERED,
      depsFor({ listDevices: async () => [LISTED[1]!] }));
    expect(outcome).toEqual({ ok: false, cause: 'peer-unlisted' });
  });

  it('refuses an envelope with no slot for this machine', async () => {
    const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } }, PHONE, { dev_tablet: STRANGER.publicKey });
    expect(await open(response)).toEqual({ ok: false, cause: 'no-slot' });
  });

  it('refuses a tampered ciphertext without saying anything about it', async () => {
    const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } });
    const envelope = JSON.parse(response.sealed.body) as { ciphertext: string; iv: string };
    const bytes = unb64(envelope.ciphertext);
    bytes[0] = bytes[0]! ^ 1;
    response.sealed.body = JSON.stringify({ ...envelope, ciphertext: b64(bytes) });
    expect(await open(response)).toEqual({ ok: false, cause: 'unreadable' });
  });

  it('refuses an authenticated body that is not JSON, without its text', async () => {
    const { seal } = await asDevice(ASKER);
    // sealAs JSON-encodes; build the odd plaintext by sealing a string literal through a raw content value.
    const odd = await sealAs(PHONE, 'SECRET-NOT-AN-OBJECT' as unknown as PushBodyInput, toAsker);
    const outcome = await seal.openAnswer({ sealed: odd, respondedDeviceId: 'dev_phone' } as never, ASK_ID, OFFERED, depsFor());
    expect(outcome).toEqual({ ok: false, cause: 'unreadable' });
    expect(JSON.stringify(outcome)).not.toContain('SECRET');
  });

  it('refuses a choice that was not offered', async () => {
    const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'rm-rf' } });
    expect(await open(response)).toEqual({ ok: false, cause: 'unknown-action' });
    expect(await open(response, {}, undefined)).toEqual({ ok: false, cause: 'unknown-action' });
  });

  it('refuses an answer with neither a choice nor text', async () => {
    const response = await answerFrom({ answer: { ask: ASK_ID } });
    expect(await open(response)).toEqual({ ok: false, cause: 'empty-answer' });
  });

  it('reports the device list failing as peer-unusable, and opens past a trust file it cannot read', async () => {
    const response = await answerFrom({ answer: { ask: ASK_ID, actionId: 'approve' } });
    expect(await open(response, { listDevices: async () => { throw new Error('devices 503'); } })).toEqual({ ok: false, cause: 'peer-unusable' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeFileSync(trustPath, '{ not json');
    expect(await open(response)).toEqual({ ok: true, actionId: 'approve' });
  });
});
