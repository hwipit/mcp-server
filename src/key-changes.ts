/**
 * Devices whose key changed since this computer pinned them, kept until a person has been shown it (twin of the cli's
 * `src/key-changes.ts`, same contract).
 *
 * Whoever replaces a pin — the cli's notify, ask, agent send and listener, and this server — writes the change here,
 * under the trust file's lock (`withTrustLock`). This server's stderr reaches nobody, and once the pin holds the new
 * key no one sees the change again. So it waits beside the pins until a surface a person reads takes it: here that
 * is the result of `hwip_notify`, `hwip_file`, `hwip_ask` and `hwip_agent_send`, which ends with a `Note:` line.
 *
 * THE CONTRACT (cli and mcp-server write and read it, the plugin reads it — changing it is a cross-repo change):
 *
 *   path  key-changes.json beside trusted-devices.json (~/.hwip/key-changes.json), 0600
 *   body  {"v":1,"changes":[{"deviceId":"<device id>","at":"<ISO 8601 UTC>","name":"<nickname, optional>"}]}
 *         one entry per device, updated in place; at most 64, the oldest dropped
 *   take  under the same lock as the writers (trusted-devices.lock), rename to key-changes.json.<pid>.taken, read,
 *         delete: a writer cannot put back what was taken, and of two readers only the one whose rename wins shows
 *         the changes. A record that does not parse, or another `v`, reads as none.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEVICE_ID, TRUST_PATH, withTrustLock } from './trust-pins.js';

export interface KeyChange {
  deviceId: string;
  /** When the pin was replaced, ISO 8601 UTC. */
  at: string;
  /** The device's nickname as the account lists it. */
  name?: string;
}

export const MAX_KEY_CHANGES = 64;
const NAME_MAX = 80;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const keyChangesPath = (trustPath: string): string => join(dirname(trustPath), 'key-changes.json');

/** The relay writes nicknames: no control, direction or zero-width characters, one space per run, 80 characters at most. */
const cleanName = (name: unknown): string | undefined => {
  if (typeof name !== 'string') return undefined;
  const plain = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(plain);
  if (chars.length === 0) return undefined;
  return chars.length > NAME_MAX ? chars.slice(0, NAME_MAX).join('') : plain;
};

const entryOf = (raw: unknown): KeyChange | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const { deviceId, at, name } = raw as Record<string, unknown>;
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId) || typeof at !== 'string' || !ISO_UTC.test(at)) return null;
  const clean = cleanName(name);
  return clean === undefined ? { deviceId, at } : { deviceId, at, name: clean };
};

const readChanges = (path: string): KeyChange[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
  const { v, changes } = (raw ?? {}) as { v?: unknown; changes?: unknown };
  if (v !== 1 || !Array.isArray(changes)) return [];
  return changes.map(entryOf).filter((c): c is KeyChange => c !== null).slice(-MAX_KEY_CHANGES);
};

/** One entry per device, the later one in place of the earlier. */
const merge = (list: KeyChange[], changes: KeyChange[]): KeyChange[] => {
  for (const change of changes) {
    const entry = entryOf(change);
    if (!entry) continue;
    const at = list.findIndex((c) => c.deviceId === entry.deviceId);
    if (at >= 0) list[at] = entry;
    else list.push(entry);
  }
  return list.slice(-MAX_KEY_CHANGES);
};

/**
 * Add `changes` to the record. Call it inside the `withTrustLock` section that replaced the pins: that lock is what
 * keeps two writers from dropping each other's entry, and a taker from seeing an entry twice. Throws nothing: false
 * means the record could not be written, and the caller holds the changes instead (`holdKeyChanges`).
 */
export const recordKeyChanges = (trustPath: string, changes: KeyChange[]): boolean => {
  if (changes.length === 0) return true;
  const path = keyChangesPath(trustPath);
  const list = merge(readChanges(path), changes);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify({ v: 1, changes: list })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
    return true;
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* the folder is not there either */ }
    return false;
  }
};

/** Changes this process saw but could not record (the pin or the record was not written): shown by its next result. */
let held: KeyChange[] = [];

export const holdKeyChanges = (changes: KeyChange[]): void => {
  held = merge(held, changes);
};

const takeRecord = (path: string): KeyChange[] => {
  const taken = `${path}.${process.pid}.taken`;
  try {
    renameSync(path, taken);
  } catch {
    return [];
  }
  try {
    return readChanges(taken);
  } finally {
    rmSync(taken, { force: true });
  }
};

/** The changes nobody has been shown yet, and the record gone. A lock that cannot be had leaves the record for the next result. */
export const takeKeyChanges = (trustPath: string, opts: { waitMs?: number } = {}): KeyChange[] => {
  const mine = held;
  held = [];
  const path = keyChangesPath(trustPath);
  // Most results find nothing: no lock for them.
  if (!existsSync(path)) return mine;
  const done = withTrustLock(trustPath, () => takeRecord(path), opts);
  return done.locked ? merge(mine, done.value) : mine;
};

/** Other lines for the next result, each said once per process: a failure that repeats on every send is said the first time. */
const said = new Set<string>();
let notes: string[] = [];

export const noteOnce = (text: string): void => {
  if (said.has(text)) return;
  said.add(text);
  notes.push(text);
};

/** One line for a person; the caller adds its prefix. */
export const describeKeyChange = (change: KeyChange): string =>
  `${change.name ?? change.deviceId} changed its encryption key — the new key is trusted. If you did not expect this, check it with: hwip trust`;

/**
 * `result` ending with one `Note:` text block per change not shown yet and per `noteOnce` line, which are then cleared.
 * Only text: a tool's JSON keeps its keys.
 */
export const withKeyChangeNote = (result: CallToolResult, trustPath: string = TRUST_PATH): CallToolResult => {
  const lines = [...takeKeyChanges(trustPath).map(describeKeyChange), ...notes];
  notes = [];
  if (lines.length === 0) return result;
  return { ...result, content: [...result.content, ...lines.map((line) => ({ type: 'text' as const, text: `Note: ${line}` }))] };
};

/** A tool handler whose result carries the key changes not shown yet (`withKeyChangeNote`). */
export const notingKeyChanges = <A extends unknown[]>(handler: (...args: A) => Promise<CallToolResult>) =>
  async (...args: A): Promise<CallToolResult> => withKeyChangeNote(await handler(...args));
