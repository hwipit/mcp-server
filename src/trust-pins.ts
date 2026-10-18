/**
 * Pinning the account's devices as a sender sees them (twin of the cli's `src/trust-pins.ts` and `src/trust-lock.ts`).
 *
 * `hwip_notify`, `hwip_file`, `hwip_ask` and `hwip_agent_send` read `GET /devices` before they seal. Every device that
 * lists a key is pinned the first time it is seen, and a pin whose device now lists another key is replaced — with one
 * warning, because a key that changed is also what a relay swapping the list looks like, and a record (`key-changes.ts`)
 * the next tool result shows, since this server's stderr reaches nobody. Nothing here decides who is
 * sealed for: the list does. The pins are what the cli listener holds a request against and what a person compares
 * with `hwip trust`; trust never stops a send.
 *
 * The file is shared with the cli, which also keeps the listener's sealed-command numbers in it (`commands`,
 * `commandKeys`). Every writer re-reads it under `trusted-devices.lock` and rewrites only its own part: here that is
 * `devices` (and, for a replaced pin, the old key's command number carried into `commandKeys`, as the cli does), with
 * every other field kept as it was. `sealedOnce` is read past and not written back.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { publicKeySender, samePublicKey } from './crypto.js';
import { holdKeyChanges, recordKeyChanges, type KeyChange } from './key-changes.js';

/** The cli listener's state file. */
export const TRUST_PATH = join(homedir(), '.hwip', 'trusted-devices.json');

/** A device id as the app, the cli and the server mint them. */
export const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Devices pinned at most: a list padded with made-up devices must not grow the file one rewrite at a time. */
export const MAX_PINNED_DEVICES = 64;
const TRUST_VERSION = 1;
/** A lock older than this was left by a process that died. */
const STALE_MS = 10_000;
const WAIT_MS = 1_000;
const POLL_MS = 20;

type Pin = { publicKey: string; pinnedAt: string };
/** The file as read: `devices` checked, every other field kept for the rewrite. */
type TrustFile = Record<string, unknown> & { devices: Record<string, Pin> };

const isCommandNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Judged as the cli's `readTrustState` judges it, so the two never disagree about the same file. */
const parseTrust = (text: string): TrustFile | null => {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  if (!('version' in raw) || raw.version !== TRUST_VERSION) return null;
  if (!('devices' in raw) || typeof raw.devices !== 'object' || raw.devices === null) return null;
  for (const pin of Object.values(raw.devices)) {
    const isPin = typeof pin === 'object' && pin !== null
      && 'publicKey' in pin && typeof pin.publicKey === 'string'
      && 'pinnedAt' in pin && typeof pin.pinnedAt === 'string';
    if (!isPin) return null;
  }
  // Absent from files written before sealed commands; when there, as the cli reads it.
  if ('commands' in raw) {
    if (typeof raw.commands !== 'object' || raw.commands === null) return null;
    if (!Object.values(raw.commands).every(isCommandNumber)) return null;
  }
  return raw as TrustFile;
};

/** The trust file: a missing one is empty, one that will not read or parse is `null`, never a guess. */
export const readTrustFile = (path: string): TrustFile | null => {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { version: TRUST_VERSION, devices: {} } : null; // err.code is how node names a missing file
  }
  try {
    return parseTrust(text);
  } catch {
    return null;
  }
};

const writeTrustFile = (path: string, file: TrustFile): void => {
  const { sealedOnce: _retired, ...kept } = file;
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  // Synced before the rename: a crash leaves the old file or the new one, not an empty one that reads as unusable.
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try {
      writeSync(fd, `${JSON.stringify({ ...kept, version: TRUST_VERSION }, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
};

const ageOf = (lock: string): number | null => {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return null;
  }
};

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Run `fn` holding `trusted-devices.lock` beside the trust file, created with `wx` as the cli creates it. `locked: false`:
 * the lock was held past `waitMs` or cannot be made, and `fn` did not run.
 */
export const withTrustLock = <T>(trustPath: string, fn: () => T, { waitMs = WAIT_MS }: { waitMs?: number } = {}): { locked: true; value: T } | { locked: false } => {
  const lock = `${trustPath.replace(/\.json$/, '')}.lock`;
  const deadline = Date.now() + waitMs;
  let brokeStale = false;
  try {
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  } catch {
    return { locked: false };
  }
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeSync(fd, `${process.pid} ${Date.now()}\n`);
      } catch {
        // An empty lock nobody owns would hold every writer off until it goes stale.
        rmSync(lock, { force: true });
        return { locked: false };
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { locked: false }; // err.code is how node names a lock that is there
      // Looked at again right before the unlink: another waiter may have broken it and taken a fresh lock meanwhile.
      const age = ageOf(lock);
      if (!brokeStale && age !== null && age > STALE_MS && (ageOf(lock) ?? 0) > STALE_MS) {
        brokeStale = true;
        try { unlinkSync(lock); } catch { /* someone else broke it first */ }
        continue;
      }
      if (Date.now() >= deadline) return { locked: false };
      sleepSync(POLL_MS);
    }
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    rmSync(lock, { force: true });
  }
};

export interface ObservedDevice {
  deviceId: string;
  publicKey?: string;
  /** The name the account lists it under, for the key-change record. */
  nickname?: string;
}

export interface Observed {
  /** Devices pinned for the first time. */
  pinned: string[];
  /** Devices whose pin was replaced by the key they list now — or would have been, when the status is not `ok`. */
  replaced: string[];
  /** Devices not pinned: their key is pinned for another id, or the cap is reached. */
  skipped: string[];
  /** `unreadable`: nothing was checked or written. `unlocked`: nothing was written. A send goes on in both cases. */
  status: 'ok' | 'unreadable' | 'unlocked';
}

type Changes = Omit<Observed, 'status'>;

/** An id is read from the file's own entries: `__proto__` or `constructor` passes `DEVICE_ID` and would read an inherited member. */
const ownEntry = (record: Record<string, unknown> | undefined, id: string): unknown =>
  record !== undefined && Object.hasOwn(record, id) ? record[id] : undefined;

/** One key is one device: a key pinned for another id is the same device under a stamp the relay picked. */
const pinnedElsewhere = (file: TrustFile, deviceId: string, sender: string): boolean =>
  Object.entries(file.devices).some(([id, pin]) => id !== deviceId && publicKeySender(pin.publicKey) === sender);

/** The listener's number for a device moves to its old key before the pin goes: a new id for that key must not start from zero. */
const foldCommandNumber = (file: TrustFile, deviceId: string, oldKey: string): void => {
  const commands = file.commands as Record<string, unknown> | undefined;
  const n = ownEntry(commands, deviceId);
  const sender = publicKeySender(oldKey);
  if (!isCommandNumber(n) || sender === null) return;
  const keys = typeof file.commandKeys === 'object' && file.commandKeys !== null && !Array.isArray(file.commandKeys)
    ? file.commandKeys as Record<string, unknown>
    : {};
  const held = keys[sender];
  file.commandKeys = { ...keys, [sender]: isCommandNumber(held) ? Math.max(held, n) : n };
};

const apply = (file: TrustFile, devices: ObservedDevice[], selfId: string | undefined, at: Date): Changes => {
  const changes: Changes = { pinned: [], replaced: [], skipped: [] };
  for (const { deviceId, publicKey } of devices) {
    if (!publicKey || deviceId === selfId || !DEVICE_ID.test(deviceId)) continue;
    const sender = publicKeySender(publicKey);
    if (sender === null) continue;
    const pin = ownEntry(file.devices, deviceId) as Pin | undefined;
    if (pin && samePublicKey(pin.publicKey, publicKey)) continue;
    const tooMany = !pin && Object.keys(file.devices).length >= MAX_PINNED_DEVICES;
    if (pinnedElsewhere(file, deviceId, sender) || tooMany) {
      changes.skipped.push(deviceId);
      continue;
    }
    if (pin) foldCommandNumber(file, deviceId, pin.publicKey);
    file.devices = { ...file.devices, [deviceId]: { publicKey, pinnedAt: at.toISOString() } };
    (pin ? changes.replaced : changes.pinned).push(deviceId);
  }
  return changes;
};

const unchanged = (c: Changes): boolean => c.pinned.length === 0 && c.replaced.length === 0;

/** A trust line on stderr, as the server writes its other lines. */
const warnOnStderr = (line: string): void => console.error(`[hwip] ${line}`);

/** Told the file is unreadable: it stays so for every send after, so each warner hears it once per process. */
const toldUnreadable = new WeakSet<(line: string) => void>();

/**
 * Pin what `devices` lists: a new device is pinned, a changed key replaces its pin with one warning. Never refuses and
 * never throws — a file that cannot be read or written leaves the pins as they were and the send goes on.
 */
export const observeDevices = (
  path: string,
  devices: ObservedDevice[],
  { selfId, now = () => new Date(), warn = warnOnStderr }: { selfId?: string; now?: () => Date; warn?: (line: string) => void } = {},
): Observed => {
  const quick = readTrustFile(path);
  if (quick === null) {
    if (!toldUnreadable.has(warn)) {
      toldUnreadable.add(warn);
      warn('trust: the trust file is unreadable — pins not checked');
    }
    return { pinned: [], replaced: [], skipped: [], status: 'unreadable' };
  }
  const at = now();
  const first = apply(quick, devices, selfId, at);
  // The usual send changes nothing: no lock, no write.
  if (unchanged(first)) return { ...first, status: 'ok' };

  const names = new Map(devices.map((d) => [d.deviceId, d.nickname]));
  const changesOf = (replaced: string[], when: Date): KeyChange[] =>
    replaced.map((deviceId) => ({ deviceId, at: when.toISOString(), name: names.get(deviceId) }));
  // Not written: the send goes on with the key the list holds, and a changed key is still said — on stderr, and by
  // this process's next tool result, since no record will.
  const notWritten = (status: 'unreadable' | 'unlocked'): Observed => {
    for (const deviceId of first.replaced) warn(`trust: ${deviceId} changed its key — could not record the new pin`);
    holdKeyChanges(changesOf(first.replaced, at));
    return { pinned: [], replaced: first.replaced, skipped: [], status };
  };

  try {
    // Read again under the lock: the listener or another send may have pinned meanwhile.
    const done = withTrustLock(path, () => {
      const latest = readTrustFile(path);
      if (latest === null) return null;
      const when = now();
      const changes = apply(latest, devices, selfId, when);
      if (unchanged(changes)) return changes;
      writeTrustFile(path, latest);
      // In the same section as the pin: a process that sees the new key as `same` next has nothing left to say it.
      const keyChanges = changesOf(changes.replaced, when);
      if (!recordKeyChanges(path, keyChanges)) {
        warn('trust: could not save that key change for later (key-changes.json) — the next tool result notes it');
        holdKeyChanges(keyChanges);
      }
      return changes;
    });
    if (!done.locked || done.value === null) return notWritten(done.locked ? 'unreadable' : 'unlocked');
    for (const deviceId of done.value.replaced) warn(`trust: ${deviceId} changed its key — now pinned to the new one`);
    return { ...done.value, status: 'ok' };
  } catch {
    // A full disk, a folder that is not ours: the send does not depend on the pin.
    return notWritten('unlocked');
  }
};
