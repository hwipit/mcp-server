import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandSealDeps } from './command-seal.js';

// Real keys and real envelopes, as in ask-seal.test.ts: this machine is the vectors file's `sender`, the phone its
// `recipient`, and `stranger` is another computer of the account — the one a message is sent to.

interface KeyPair { publicKey: string; privateKey: string }
const KEYS = (JSON.parse(readFileSync(new URL('./crypto-labels.vectors.json', import.meta.url), 'utf8')) as {
  keys: { sender: KeyPair; recipient: KeyPair; stranger: KeyPair };
}).keys; // own fixture file
const THIS_MACHINE = KEYS.sender;
const PHONE = KEYS.recipient;
const OTHER_PC = KEYS.stranger;

let TMP: string;
let trustPath: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'command-seal-'));
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
const asDevice = async (keys: KeyPair): Promise<{ crypto: typeof import('./crypto.js'); seal: typeof import('./command-seal.js') }> => {
  const home = mkdtempSync(join(TMP, 'home-'));
  mkdirSync(join(home, '.hwip'), { recursive: true });
  writeFileSync(join(home, '.hwip', 'device-keys.json'), JSON.stringify(keys));
  process.env.HOME = home;
  vi.resetModules();
  const cryptoMod = await import('./crypto.js');
  await cryptoMod.initCrypto();
  return { crypto: cryptoMod, seal: await import('./command-seal.js') };
};

const LISTED = [
  { deviceId: 'dev_laptop', publicKey: THIS_MACHINE.publicKey },
  { deviceId: 'dev_other_pc', publicKey: OTHER_PC.publicKey },
  { deviceId: 'dev_phone', publicKey: PHONE.publicKey },
];
const COMMAND = { targetDeviceId: 'dev_other_pc', session: 'hwip-api', message: '[from cli@laptop] run the tests' };

const depsFor = (overrides: Partial<CommandSealDeps> = {}): CommandSealDeps => ({
  loadKeys: async () => undefined,
  self: () => ({ deviceId: 'dev_laptop', publicKey: THIS_MACHINE.publicKey }),
  listDevices: async () => LISTED,
  // A server without the route yet: what a test that lists this machine nowhere meets.
  register: async () => 'http 404',
  trustPath,
  nextNumber: async () => 1700000000001,
  ...overrides,
});

/** What the target computer reads: its slot opened with its own key. */
const openAsTarget = async (fields: { body: string; senderPublicKey: string; deviceKeyMap: Record<string, string> }, slot = 'dev_other_pc', keys = OTHER_PC) => {
  const { crypto } = await asDevice(keys);
  return crypto.decryptPushBodyForDevice(fields.body, fields.deviceKeyMap[slot], fields.senderPublicKey);
};

const recordingSealer = () => vi.fn(async (_content: unknown, recipients: { deviceId: string }[]) => ({
  isEncrypted: true as const, body: 'x', senderPublicKey: THIS_MACHINE.publicKey,
  deviceKeyMap: Object.fromEntries(recipients.map((r) => [r.deviceId, '{}'])),
}));

describe('sealedCommand', () => {
  it('seals for a pinned computer: the target opens the label with its own key, the text is not in the body', async () => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey, dev_phone: PHONE.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);

    const prepared = await seal.sealedCommand(COMMAND, depsFor());

    expect(prepared.kind).toBe('sealed');
    if (prepared.kind !== 'sealed') return;
    expect(prepared.fields.body).not.toContain('run the tests');
    expect(prepared.fields.senderPublicKey).toBe(THIS_MACHINE.publicKey);
    expect(Object.keys(prepared.fields.deviceKeyMap).sort()).toEqual(['dev_other_pc', 'dev_phone']);
    const opened = await openAsTarget(prepared.fields);
    expect(opened.body).toBe(COMMAND.message);
    expect(opened.cmd).toEqual({ n: 1700000000001, session: 'hwip-api', device: 'dev_other_pc', from: 'dev_laptop' });
  });

  it('lets the phone open the same message from its own slot', async () => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey, dev_phone: PHONE.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);
    const prepared = await seal.sealedCommand(COMMAND, depsFor());
    if (prepared.kind !== 'sealed') throw new Error('not sealed');

    const opened = await openAsTarget(prepared.fields, 'dev_phone', PHONE);

    expect(opened.body).toBe(COMMAND.message);
  });

  it('seals for another session on this very computer with no pin', async () => {
    const { seal } = await asDevice(THIS_MACHINE);

    const prepared = await seal.sealedCommand({ ...COMMAND, targetDeviceId: 'dev_laptop' }, depsFor());

    expect(prepared.kind).toBe('sealed');
    if (prepared.kind !== 'sealed') return;
    const opened = await openAsTarget(prepared.fields, 'dev_laptop', THIS_MACHINE);
    expect(opened.cmd).toEqual({ n: 1700000000001, session: 'hwip-api', device: 'dev_laptop', from: 'dev_laptop' });
  });

  it('sends to a computer seen for the first time, and pins every listed device but this machine', async () => {
    const { seal } = await asDevice(THIS_MACHINE);

    const prepared = await seal.sealedCommand(COMMAND, depsFor());

    expect(prepared.kind).toBe('sealed');
    expect(pinnedKeys()).toEqual({ dev_other_pc: OTHER_PC.publicKey, dev_phone: PHONE.publicKey });
  });

  it('sends to a computer that is not pinned while other devices are', async () => {
    pinFile({ dev_phone: PHONE.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);

    expect((await seal.sealedCommand(COMMAND, depsFor())).kind).toBe('sealed');
  });

  it('seals for the key a computer lists now when it changed, and moves its pin with one warning', async () => {
    pinFile({ dev_other_pc: PHONE.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const prepared = await seal.sealedCommand(COMMAND, depsFor());

    if (prepared.kind !== 'sealed') throw new Error('expected a sealed command');
    expect((await openAsTarget(prepared.fields)).body).toBe(COMMAND.message);
    expect(pinnedKeys().dev_other_pc).toBe(OTHER_PC.publicKey);
    expect(warn).toHaveBeenCalledWith('[hwip] trust: dev_other_pc changed its key — now pinned to the new one');
  });

  it('does not send to a computer the account does not list', async () => {
    pinFile({ dev_phone: PHONE.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);

    expect(await seal.sealedCommand({ ...COMMAND, targetDeviceId: 'dev_gone' }, depsFor())).toEqual({ kind: 'refused', cause: 'target-unlisted' });
  });

  it('does not send when this machine cannot be registered, and says why', async () => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);

    const unlisted = LISTED.filter((d) => d.deviceId !== 'dev_laptop');
    expect(await seal.sealedCommand(COMMAND, depsFor({ listDevices: async () => unlisted }))).toEqual({ kind: 'refused', cause: 'self-unlisted', why: 'http 404' });
    expect(seal.commandRefusalMessage('self-unlisted', 'http 404')).toBe(
      'sealed send: could not register this machine\'s key in the account\'s device list (the server answered HTTP 404); the message was not sent',
    );
  });

  it('does not register this machine when the list holds it under its key', async () => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);
    const register = vi.fn(async () => null);

    expect((await seal.sealedCommand(COMMAND, depsFor({ register }))).kind).toBe('sealed');
    expect(register).not.toHaveBeenCalled();
  });

  it('puts this machine\'s key on the list once when it is missing, then seals, without reading the list again', async () => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);
    const register = vi.fn(async () => null);
    const unlisted = LISTED.filter((d) => d.deviceId !== 'dev_laptop');
    const listDevices = vi.fn(async () => unlisted);

    expect((await seal.sealedCommand(COMMAND, depsFor({ listDevices, register }))).kind).toBe('sealed');
    expect(register).toHaveBeenCalledWith({ deviceId: 'dev_laptop', publicKey: THIS_MACHINE.publicKey });
    expect(register).toHaveBeenCalledTimes(1);
    expect(listDevices).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'timeout'] as const)('does not send when registering fails with %s', async (why) => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);

    const unlisted = LISTED.filter((d) => d.deviceId !== 'dev_laptop');
    expect(await seal.sealedCommand(COMMAND, depsFor({ listDevices: async () => unlisted, register: async () => why }))).toEqual({ kind: 'refused', cause: 'self-unlisted', why });
  });

  it('refuses when the list holds another key for this machine and the API key may not replace it', async () => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);
    const listDevices = async () => LISTED.map((d) => (d.deviceId === 'dev_laptop' ? { ...d, publicKey: OTHER_PC.publicKey } : d));

    expect(await seal.sealedCommand(COMMAND, depsFor({ listDevices, register: async () => 'http 403' }))).toEqual({ kind: 'refused', cause: 'self-unlisted', why: 'replace-forbidden' });
  });

  it.each([
    ['the keys do not load', { loadKeys: async () => { throw new Error('no keys'); } }, 'keystore'],
    ['the device list cannot be fetched', { listDevices: async () => { throw new Error('offline'); } }, 'devices'],
  ] as const)('does not send when %s', async (_name, override, cause) => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);

    expect(await seal.sealedCommand(COMMAND, depsFor(override))).toEqual({ kind: 'refused', cause });
  });

  it('still sends when the trust file cannot be read, and leaves it as it is', async () => {
    writeFileSync(trustPath, '{not json');
    const { seal } = await asDevice(THIS_MACHINE);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect((await seal.sealedCommand(COMMAND, depsFor())).kind).toBe('sealed');
    expect(readFileSync(trustPath, 'utf8')).toBe('{not json');
  });

  it.each([
    ['the counter is locked', { refused: 'lock' }, 'number-locked'],
    ['the counter cannot be used', { refused: 'io' }, 'number-unusable'],
  ] as const)('does not send when %s', async (_name, refusal, cause) => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);
    const sealIt = vi.fn();

    expect(await seal.sealedCommand(COMMAND, depsFor({ nextNumber: async () => refusal, seal: sealIt }))).toEqual({ kind: 'refused', cause });
    expect(sealIt).not.toHaveBeenCalled();
  });

  it('does not send when sealing fails, and says nothing of why', async () => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);

    const prepared = await seal.sealedCommand(COMMAND, depsFor({ seal: async () => { throw new Error('secret plaintext'); } }));

    expect(prepared).toEqual({ kind: 'refused', cause: 'encrypt' });
  });

  // A device the list adds is the relay's to add: with no pin to say otherwise, nobody but the target reads the message.
  it('seals for this computer first, then every other listed device with a key', async () => {
    const { seal } = await asDevice(THIS_MACHINE);
    const sealIt = recordingSealer();

    const prepared = await seal.sealedCommand({ ...COMMAND, targetDeviceId: 'dev_laptop' }, depsFor({ seal: sealIt }));

    expect(prepared.kind).toBe('sealed');
    expect(sealIt.mock.calls[0]?.[1].map((r) => r.deviceId)).toEqual(['dev_laptop', 'dev_other_pc', 'dev_phone']);
  });

  it('seals for the target first, then every other listed device with a key, whatever is pinned', async () => {
    pinFile({ dev_tablet: PHONE.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);
    const sealIt = recordingSealer();
    const listed = [...LISTED, { deviceId: 'dev_keyless' }];

    await seal.sealedCommand(COMMAND, depsFor({ seal: sealIt, listDevices: async () => listed }));

    expect(sealIt.mock.calls[0]?.[1].map((r) => r.deviceId)).toEqual(['dev_other_pc', 'dev_phone']);
  });

  it('does not send when the sealer left the target without a slot', async () => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);

    const prepared = await seal.sealedCommand(COMMAND, depsFor({
      seal: async () => ({ body: 'x', senderPublicKey: 'y', deviceKeyMap: { dev_phone: 'z' } }),
    }));

    expect(prepared).toEqual({ kind: 'refused', cause: 'encrypt' });
  });

  it('takes a fresh number from the shared counter for every message', async () => {
    pinFile({ dev_other_pc: OTHER_PC.publicKey });
    const { seal } = await asDevice(THIS_MACHINE);
    let n = 40;

    const first = await seal.sealedCommand(COMMAND, depsFor({ nextNumber: async () => ++n }));
    const second = await seal.sealedCommand(COMMAND, depsFor({ nextNumber: async () => ++n }));
    if (first.kind !== 'sealed' || second.kind !== 'sealed') throw new Error('not sealed');

    expect((await openAsTarget(first.fields)).cmd?.n).toBe(41);
    expect((await openAsTarget(second.fields)).cmd?.n).toBe(42);
  });

  it('writes nothing once every listed device is pinned, and keeps the listener\'s numbers when it pins', async () => {
    writeFileSync(trustPath, JSON.stringify({ version: 1, devices: { dev_other_pc: { publicKey: OTHER_PC.publicKey, pinnedAt: '2026-10-01T00:00:00.000Z' } }, commands: { dev_phone: 4 } }));
    const { seal } = await asDevice(THIS_MACHINE);

    await seal.sealedCommand(COMMAND, depsFor());
    expect(JSON.parse(readFileSync(trustPath, 'utf8')).commands).toEqual({ dev_phone: 4 });
    const after = readFileSync(trustPath, 'utf8');

    await seal.sealedCommand({ ...COMMAND, targetDeviceId: 'dev_phone' }, depsFor());
    expect(readFileSync(trustPath, 'utf8')).toBe(after);
  });
});
