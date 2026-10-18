/**
 * Per-device encryption for the MCP server — self-contained ECDH P-256 +
 * AES-256-GCM. Mirrors @hwip/crypto API but bundled inline (no external
 * dependency). Uses Web Crypto API via node:crypto webcrypto — Node.js 18+
 * (the `crypto` global only exists unflagged from Node 19, so we import it).
 *
 * How it works (ADR-0007):
 *
 *   This host holds one ECDH keypair, in ~/.hwip/device-keys.json — the
 *   Machine Device's, shared with `hwip listener`. Either puts its public half
 *   on the device record when the list lacks it (`self-register.ts`). Whichever
 *   process starts first creates it; the
 *   private half never leaves the host — the server only ever sees public
 *   keys. A push is encrypted once
 *   with a random AES key, and that key is wrapped separately for each of the
 *   user's registered devices using ECDH(this host, that device).
 *
 *   That makes it end-to-end in the standard sense: the backend stores
 *   ciphertext plus wrapped keys it cannot unwrap.
 *
 * What it still does not give you:
 *   • Forward secrecy — the ECDH secret for a given (sender, device) pair is
 *     static, so a compromise of either private key retroactively opens every
 *     push wrapped for that pair. The per-message AES key is random; its wrap
 *     key is not.
 *   • Authenticity beyond the key pairing — nothing signs `senderPublicKey`,
 *     so a server that swapped it could make a push undecryptable, though not
 *     readable.
 *
 * Superseded scheme: a single account-wide keypair whose private half the
 * backend escrowed so it could sync to new devices. Key escrow was removed
 * server-side, which left this client waiting for a private key
 * the API stopped returning — encryption was silently off for months. Nothing
 * here asks for that key any more.
 */

/// <reference lib="dom" />

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, linkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomBytes, webcrypto } from 'node:crypto';

// Node 18 has no `crypto` global (unflagged only from 19.0.0) — resolve the
// Web Crypto implementation explicitly so encryption works on the declared
// minimum runtime instead of silently staying disabled.
const crypto = webcrypto as unknown as Crypto;

// ─── Base64 helpers ───

const toBase64 = (buffer: ArrayBuffer): string =>
  Buffer.from(buffer).toString('base64');

const fromBase64 = (base64: string): ArrayBuffer => {
  const buf = Buffer.from(base64, 'base64');
  // Slice to the exact byte range — Buffer may share a larger pooled
  // ArrayBuffer, so `.buffer` alone could expose unrelated memory.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

// ─── ECDH key management ───

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

interface ExportedKeyPair {
  publicKey: string;   // Base64-encoded SPKI
  privateKey: string;  // Base64-encoded PKCS8
}

const generateKeyPair = async (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);

const exportKeyPair = async (keyPair: CryptoKeyPair): Promise<ExportedKeyPair> => {
  const [publicRaw, privateRaw] = await Promise.all([
    crypto.subtle.exportKey('spki', keyPair.publicKey),
    crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  ]);
  return { publicKey: toBase64(publicRaw), privateKey: toBase64(privateRaw) };
};

const importPublicKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('spki', fromBase64(base64), ECDH_PARAMS, true, []);

const importPrivateKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('pkcs8', fromBase64(base64), ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);

const importKeyPair = async (exported: ExportedKeyPair): Promise<CryptoKeyPair> => {
  const [publicKey, privateKey] = await Promise.all([
    importPublicKey(exported.publicKey),
    importPrivateKey(exported.privateKey),
  ]);
  return { publicKey, privateKey };
};

const deriveAesKey = async (privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

// ─── Recipients ───

/** One target device, as returned by `GET /devices`. */
export interface DeviceRecipient {
  deviceId: string;
  /** Base64 SPKI of that device's per-device public key. */
  publicKey: string;
}

/** deviceId → JSON `{ encryptedKey, keyIv }`, the wire shape the clients parse. */
export type DeviceKeyMap = Record<string, string>;

/**
 * Wrap one raw AES key for every recipient device.
 *
 * The payload is encrypted once and only the 44-byte wrapped key repeats, so
 * an attachment costs one S3 object regardless of how many devices the account
 * has. A recipient whose public key will not import is dropped rather than
 * failing the send — one broken device record must not silence every push.
 */
const wrapForDevices = async (
  rawKey: ArrayBuffer,
  senderPrivateKey: CryptoKey,
  recipients: DeviceRecipient[],
): Promise<DeviceKeyMap> => {
  const entries = await Promise.all(
    recipients.map(async ({ deviceId, publicKey }) => {
      try {
        const sharedKey = await deriveAesKey(senderPrivateKey, await importPublicKey(publicKey));
        const keyIv = crypto.getRandomValues(new Uint8Array(12));
        const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, sharedKey, rawKey);
        return [
          deviceId,
          JSON.stringify({ encryptedKey: toBase64(wrapped), keyIv: toBase64(keyIv.buffer as ArrayBuffer) }),
        ] as const;
      } catch (err) {
        console.error(`[Crypto] Skipping device ${deviceId} — unusable public key:`, err);
        return null;
      }
    }),
  );

  const keyMap: DeviceKeyMap = {};
  for (const entry of entries) {
    if (entry) keyMap[entry[0]] = entry[1];
  }
  if (Object.keys(keyMap).length === 0) throw new Error('No recipient device accepted the wrapped key');
  return keyMap;
};

// ─── Key persistence ───

const OLD_KEYS_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'hwip');
// Superseded account-wide keypair. Never written any more; only deleted.
const LEGACY_KEYS_PATH = join(OLD_KEYS_DIR, 'keys.json');
// This server's own keypair before it shared the machine's. Deleted too: past
// pushes each carry the `senderPublicKey` they were wrapped with, and a
// recipient opens them with its own private key — nothing needs this one.
const RETIRED_DEVICE_KEYS_PATH = join(OLD_KEYS_DIR, 'device-keys.json');
// The Machine Device keypair (ADR-0007), the same file `hwip listener` uses.
const DEVICE_KEYS_DIR = join(homedir(), '.hwip');
const DEVICE_KEYS_PATH = join(DEVICE_KEYS_DIR, 'device-keys.json');

const loadDeviceKeys = (): ExportedKeyPair | null => {
  try {
    const parsed = JSON.parse(readFileSync(DEVICE_KEYS_PATH, 'utf-8')) as ExportedKeyPair;
    return parsed.publicKey && parsed.privateKey ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Create the keypair file, exclusively. The listener creates the same file,
 * and two processes each writing their own pair would leave one of them
 * signing with a key that is not on disk. Returns what is on disk afterwards:
 * ours, or the pair that won the race.
 */
const storeDeviceKeys = (exported: ExportedKeyPair): ExportedKeyPair => {
  mkdirSync(DEVICE_KEYS_DIR, { recursive: true, mode: 0o700 });
  // Written whole to a private temp name, then linked into place: `link` is
  // atomic and fails if the name exists, so the file under the real name is
  // never half-written, and a process that loses the race reads a complete one.
  const temp = `${DEVICE_KEYS_PATH}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(exported, null, 2), { mode: 0o600, flag: 'wx' });
  try {
    linkSync(temp, DEVICE_KEYS_PATH);
    return exported;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const winner = loadDeviceKeys();
    if (!winner) throw new Error(`${DEVICE_KEYS_PATH} exists but holds no keypair`);
    return winner;
  } finally {
    try { unlinkSync(temp); } catch { /* already gone — fine */ }
  }
};

const deleteRetiredKeys = (): void => {
  for (const path of [LEGACY_KEYS_PATH, RETIRED_DEVICE_KEYS_PATH]) {
    try { unlinkSync(path); } catch { /* not present — fine */ }
  }
};

// ─── Cached state ───

let cachedKeyPair: CryptoKeyPair | null = null;
let cachedExportedPublicKey: string | null = null;
let initPromise: Promise<string> | null = null;
/** The API key of a start that failed: the next send starts again with it, so a key file fixed meanwhile needs no restart. */
let failedApiKey: string | undefined;

/**
 * Initialize crypto.
 *
 * This host generates its own keypair on first use and keeps it, whatever the
 * account's plan: the keypair is this machine's identity, registered ungated so
 * that any device can address it (ADR-0013 decision 3, amended 2026-09-16).
 * The private key is created here and stays here. Every push is sealed (F16):
 * there is no account setting and no host switch that turns it off.
 *
 * Asks the server nothing. Safe to call concurrently — deduplicates to a single init.
 * Returns this host's public key, or '' when it has none.
 */
export const initCrypto = (apiKey?: string): Promise<string> => {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Local-only mode (no apiKey): used by tests and offline setups. An existing
    // device keypair is adopted and a missing one is not created — nothing sends
    // without an apiKey, so there is nothing to make it for.
    if (!apiKey) {
      const stored = loadDeviceKeys();
      if (!stored) {
        disableCrypto();
        return '';
      }
      cachedKeyPair = await importKeyPair(stored);
      cachedExportedPublicKey = stored.publicKey;
      return stored.publicKey;
    }

    // Drop the escrowed account keypair if an old build left one on disk — it
    // holds a private key this process has no use for and the server no longer
    // accepts.
    deleteRetiredKeys();
    const stored = loadDeviceKeys();
    if (stored) {
      cachedKeyPair = await importKeyPair(stored);
      cachedExportedPublicKey = stored.publicKey;
      return stored.publicKey;
    }

    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);
    const onDisk = storeDeviceKeys(exported);
    cachedKeyPair = onDisk === exported ? keyPair : await importKeyPair(onDisk);
    cachedExportedPublicKey = onDisk.publicKey;
    return onDisk.publicKey;
  })().then((publicKey) => {
    failedApiKey = undefined;
    return publicKey;
  }, (err) => {
    initPromise = null;
    failedApiKey = apiKey;
    throw err;
  });
  return initPromise;
};

/**
 * Resolves once the start-up `initCrypto` has settled, however it went. index.ts connects the
 * MCP transport without waiting for it, so the first send waits here instead. A start that
 * failed (a key file that would not load) is tried once more for each send that finds no keys.
 */
export const cryptoReady = async (): Promise<void> => {
  await (initPromise ?? Promise.resolve('')).then(() => undefined, () => undefined);
  if (cachedKeyPair || failedApiKey === undefined) return;
  await initCrypto(failedApiKey).then(() => undefined, () => undefined);
};

/** One line for stderr saying what `initCrypto` found. */
export const cryptoStatusLine = (): string => {
  if (!cachedKeyPair) return '[Crypto] This machine has no device keys — every push will fail until they load.';
  return `[Crypto] E2E encryption on (publicKey: ${cachedExportedPublicKey?.slice(0, 20)}...) — every push, question and command is sealed.`;
};

/**
 * Keep only devices this host can actually encrypt for.
 *
 * A device without a public key has never run a build that registers one:
 * wrapping for it produces a push it cannot open.
 */
export const selectRecipients = (
  devices: { deviceId: string; publicKey?: string }[],
): DeviceRecipient[] =>
  devices
    .filter((d): d is DeviceRecipient => !!d.publicKey)
    .map(({ deviceId, publicKey }) => ({ deviceId, publicKey }));

export const getKeyPair = (): CryptoKeyPair | null => cachedKeyPair;
export const getPublicKey = (): string | null => cachedExportedPublicKey;

/**
 * Drop everything, keypair included, so this host does no crypto at all.
 *
 * Only the keyless path in `initCrypto` uses this. Keys on disk are untouched; a restart re-adopts them.
 */
export const disableCrypto = (): void => {
  cachedKeyPair = null;
  cachedExportedPublicKey = null;
};

/**
 * Encrypt a push body for the given recipient devices.
 *
 * Returns the wire fields the API expects: `body` carries the ciphertext and
 * IV, `deviceKeyMap` the per-device wrapped keys, `senderPublicKey` the half
 * recipients need to derive the same secret back.
 */
export const encryptPushBodyForDevices = async (
  input: PushBodyInput,
  recipients: DeviceRecipient[],
): Promise<{
  body: string;
  deviceKeyMap: DeviceKeyMap;
  senderPublicKey: string;
  isEncrypted: true;
}> => {
  if (!cachedKeyPair || !cachedExportedPublicKey) throw new Error('Crypto not initialized');
  assertAskWithinLimits(input.ask);

  const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    messageKey,
    new TextEncoder().encode(
      JSON.stringify({
        title: input.title,
        body: input.body,
        url: input.url,
        cmd: input.cmd,
        ask: input.ask,
        answer: input.answer,
        files: input.files,
        keys: input.keys,
        ifPrompt: input.ifPrompt,
        context: input.context,
      }),
    ),
  );
  const rawMessageKey = await crypto.subtle.exportKey('raw', messageKey);

  return {
    body: JSON.stringify({ ciphertext: toBase64(ciphertext), iv: toBase64(iv.buffer as ArrayBuffer) }),
    deviceKeyMap: await wrapForDevices(rawMessageKey, cachedKeyPair.privateKey, recipients),
    senderPublicKey: cachedExportedPublicKey,
    isEncrypted: true,
  };
};

/**
 * Encrypt file content for the given recipient devices.
 */
export const encryptFileForDevices = async (
  content: string | Buffer,
  recipients: DeviceRecipient[],
): Promise<{ ciphertext: Buffer; iv: string; deviceKeyMap: DeviceKeyMap }> => {
  if (!cachedKeyPair) throw new Error('Crypto not initialized');

  // Binary attachments arrive as a Buffer and must be encrypted byte for byte —
  // running them through TextEncoder would UTF-8 mangle every non-ASCII byte.
  // Both branches are views; subtle.encrypt honours byteOffset/byteLength, so a
  // Buffer carved out of Node's pool encrypts only its own bytes.
  const buffer =
    typeof content === 'string'
      ? new TextEncoder().encode(content)
      : new Uint8Array(content.buffer as ArrayBuffer, content.byteOffset, content.byteLength);

  const fileKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, buffer);
  const rawFileKey = await crypto.subtle.exportKey('raw', fileKey);

  return {
    ciphertext: Buffer.from(ciphertext),
    iv: toBase64(iv.buffer as ArrayBuffer),
    deviceKeyMap: await wrapForDevices(rawFileKey, cachedKeyPair.privateKey, recipients),
  };
};

// ─── Opening a sealed push body ───
//
// Twin of the cli's `src/crypto.ts` (same wire format, same label parsing, same
// vectors in crypto-labels.vectors.json). An ask round trip opens the answer the
// phone sealed for this host with the Machine Device key.

/**
 * Open this device's slot in a `deviceKeyMap` (the JSON `{ encryptedKey,
 * keyIv }` `wrapForDevices` writes) and return the raw AES key inside —
 * the per-file key for an attachment, or the message key for a push body.
 * The ECDH secret is derived from this device's private half and the
 * sender's `senderPublicKey`; anything but that pairing fails the GCM tag
 * and rejects. Requires initCrypto().
 */
const unwrapDeviceKeyRaw = async (entryJson: string, senderPublicKeyRaw: string): Promise<ArrayBuffer> => {
  if (!cachedKeyPair) throw new Error('Crypto not initialized');
  const entry = JSON.parse(entryJson) as { encryptedKey?: unknown; keyIv?: unknown }; // fields are type-checked on the next line
  if (typeof entry.encryptedKey !== 'string' || typeof entry.keyIv !== 'string') {
    throw new Error('deviceKeyMap entry is not { encryptedKey, keyIv }');
  }
  const sharedKey = await deriveAesKey(cachedKeyPair.privateKey, await importPublicKey(senderPublicKeyRaw));
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromBase64(entry.keyIv)) },
    sharedKey,
    fromBase64(entry.encryptedKey),
  );
};

/**
 * The label a sealed REST command carries inside its body (M5 D8): which
 * session on which machine it is for, and a number that only grows per
 * sender. A sealed body without one is not a command. `from` is the id of the
 * computer that sent it, when it names itself.
 */
export interface SealedCommandLabel {
  n: number;
  session: string;
  device: string;
  from?: string;
}

/** One button of a sealed question: `id` and `style` also reach the server in the clear, `label` never does. */
export interface SealedAskAction {
  id: string;
  label: string;
  style?: string;
}

/**
 * The label a sealed question carries inside its body: the asker's own random
 * `id` (the answer must echo it, so a relay cannot pass an old question's answer
 * off as a new one's), the Machine Device that asks, and the wording the server
 * must not read.
 */
export interface SealedAskLabel {
  id: string;
  device: string;
  actions?: SealedAskAction[];
  placeholder?: string;
}

/**
 * The summary a sealed question may carry in its body under `context` (F3): what the asking session has changed
 * and how much of its screen the original holds. It is a new key of the same plaintext JSON — the envelope and
 * the schema are unchanged, and a reader that does not know the key drops it with the rest of the keys it does
 * not read. The original (the masked diff and screen) is never in the body: it is the question's sealed attachment.
 */
export interface SealedAskContext {
  diff: 'ok' | 'no_repo' | 'failed';
  files: number;
  added: number;
  removed: number;
  listed: { path: string; status: 'M' | 'A' | 'D' | '?'; added: number; removed: number; binary?: true }[];
  moreFiles: number;
  screenLines: number;
  masked: number;
  cut: { diff: boolean; screen: boolean };
}

/** The label a sealed answer carries: which question it answers and what was chosen. */
export interface SealedAnswerLabel {
  ask: string;
  actionId?: string;
  exit?: true;
}

/** What `encryptPushBodyForDevices` seals. Keys left out are left out of the plaintext JSON. */
export interface PushBodyInput {
  title?: string;
  body?: string;
  url?: string;
  cmd?: SealedCommandLabel;
  ask?: SealedAskLabel;
  answer?: SealedAnswerLabel;
  files?: SealedFileMeta[];
  /**
   * Named keys (the blocked prompt's answer) inside a sealed command. Only
   * non-empty string arrays read back; the listener allowlists the names.
   */
  keys?: string[];
  /** The blocked prompt id the keys answer, inside a sealed command. */
  ifPrompt?: string;
  context?: SealedAskContext;
}

/**
 * One sealed attachment as the sealed body names it (M5): its IV — fresh per
 * file, so an attachment from another message does not match — and what it
 * really is. The list binds the attachments to the message, in order.
 */
export interface SealedFileMeta {
  iv: string;
  name: string;
  type: string;
  size: number;
}

const MAX_ASK_ACTIONS = 10;
const MAX_ACTION_ID_CHARS = 64;
const MAX_ACTION_LABEL_CHARS = 100;
const MAX_ASK_ID_CHARS = 128;
/** Most files the summary lists, and the longest path it shows (bytes): the summary rides in a size-capped body. */
const MAX_CONTEXT_LISTED = 20;
const MAX_CONTEXT_PATH_BYTES = 128;
/** A device id as the account issues it (the cli's `subscriber-trust` DEVICE_ID). */
const ASK_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The reader drops a whole label that is over its limits, so a question sealed
 * past them would arrive as one with no `ask` label. Refuse at the seal instead.
 */
const assertAskWithinLimits = (ask: SealedAskLabel | undefined): void => {
  if (!ask) return;
  if (ask.id.length === 0 || ask.id.length > MAX_ASK_ID_CHARS) throw new Error(`ask id must be 1 to ${MAX_ASK_ID_CHARS} characters`);
  if (!ASK_DEVICE_ID.test(ask.device)) throw new Error('ask device id is not a device id');
  const actions = ask.actions ?? [];
  // The choices are the caller's to shorten: `ASK_CHOICES_CODE` lets `prepareAsk` say so (a property, not a class,
  // so it survives a module registry reset).
  const choices = (message: string) => Object.assign(new Error(message), { code: ASK_CHOICES_CODE });
  if (actions.length > MAX_ASK_ACTIONS) throw choices(`a question takes at most ${MAX_ASK_ACTIONS} choices`);
  if (actions.some((a) => a.id.length > MAX_ACTION_ID_CHARS)) throw choices(`a choice id is over ${MAX_ACTION_ID_CHARS} characters`);
  if (actions.some((a) => a.label.length > MAX_ACTION_LABEL_CHARS)) throw choices(`a choice label is over ${MAX_ACTION_LABEL_CHARS} characters`);
};

/** The `code` of the errors above that a shorter choice list fixes. */
export const ASK_CHOICES_CODE = 'ask-choices-over-limits';

/** Named keys inside a sealed command: non-empty strings only, like the cli socket path's
 * `isKeyList` — the listener allowlists the names. */
const sealedKeys = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((item): item is string => typeof item === 'string')) return undefined;
  return [...value];
};

const fileMetas = (value: unknown): SealedFileMeta[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const metas: SealedFileMeta[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    if (!('iv' in item) || !('name' in item) || !('type' in item) || !('size' in item)) return undefined;
    const { iv, name, type, size } = item;
    if (typeof iv !== 'string' || typeof name !== 'string' || typeof type !== 'string' || typeof size !== 'number') return undefined;
    metas.push({ iv, name, type, size });
  }
  return metas;
};

const commandLabel = (value: unknown): SealedCommandLabel | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('n' in value) || !('session' in value) || !('device' in value)) return undefined;
  const { n, session, device } = value;
  if (typeof n !== 'number' || typeof session !== 'string' || typeof device !== 'string') return undefined;
  if (!('from' in value) || value.from === undefined) return { n, session, device };
  if (typeof value.from !== 'string') return undefined;
  return { n, session, device, from: value.from };
};

const askActions = (value: unknown): SealedAskAction[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_ASK_ACTIONS) return undefined;
  const actions: SealedAskAction[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || !('id' in item) || !('label' in item)) return undefined;
    const { id, label } = item;
    if (typeof id !== 'string' || id.length > MAX_ACTION_ID_CHARS) return undefined;
    if (typeof label !== 'string' || label.length > MAX_ACTION_LABEL_CHARS) return undefined;
    if (!('style' in item) || item.style === undefined) {
      actions.push({ id, label });
      continue;
    }
    if (typeof item.style !== 'string') return undefined;
    actions.push({ id, label, style: item.style });
  }
  return actions;
};

const askLabel = (value: unknown): SealedAskLabel | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('id' in value) || !('device' in value)) return undefined;
  const { id, device } = value;
  if (typeof id !== 'string' || typeof device !== 'string') return undefined;
  if (id === '' || id.length > MAX_ASK_ID_CHARS || !ASK_DEVICE_ID.test(device)) return undefined;
  const label: SealedAskLabel = { id, device };
  if ('actions' in value && value.actions !== undefined) {
    const actions = askActions(value.actions);
    if (!actions) return undefined;
    label.actions = actions;
  }
  if ('placeholder' in value && value.placeholder !== undefined) {
    if (typeof value.placeholder !== 'string') return undefined;
    label.placeholder = value.placeholder;
  }
  return label;
};

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const contextFile = (value: unknown): SealedAskContext['listed'][number] | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { path, status, added, removed } = value as Record<string, unknown>;
  const binary = (value as Record<string, unknown>).binary;
  if (typeof path !== 'string' || path === '' || Buffer.byteLength(path) > MAX_CONTEXT_PATH_BYTES) return undefined;
  if (status !== 'M' && status !== 'A' && status !== 'D' && status !== '?') return undefined;
  const a = count(added);
  const r = count(removed);
  if (a === undefined || r === undefined) return undefined;
  if (binary === undefined) return { path, status, added: a, removed: r };
  return binary === true ? { path, status, added: a, removed: r, binary } : undefined;
};

/** The `context` summary of a sealed question, or `undefined` when it is absent or not well formed (the question still opens without it). */
export const askContext = (value: unknown): SealedAskContext | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.diff !== 'ok' && v.diff !== 'no_repo' && v.diff !== 'failed') return undefined;
  const files = count(v.files);
  const added = count(v.added);
  const removed = count(v.removed);
  const moreFiles = count(v.moreFiles);
  const screenLines = count(v.screenLines);
  const masked = count(v.masked);
  if (files === undefined || added === undefined || removed === undefined) return undefined;
  if (moreFiles === undefined || screenLines === undefined || masked === undefined) return undefined;
  if (!Array.isArray(v.listed) || v.listed.length > MAX_CONTEXT_LISTED) return undefined;
  const listed: SealedAskContext['listed'] = [];
  for (const item of v.listed) {
    const file = contextFile(item);
    if (!file) return undefined;
    listed.push(file);
  }
  const cut = v.cut as Record<string, unknown> | null | undefined;
  if (typeof cut !== 'object' || cut === null || typeof cut.diff !== 'boolean' || typeof cut.screen !== 'boolean') return undefined;
  return { diff: v.diff, files, added, removed, listed, moreFiles, screenLines, masked, cut: { diff: cut.diff, screen: cut.screen } };
};

const answerLabel = (value: unknown): SealedAnswerLabel | undefined => {
  if (typeof value !== 'object' || value === null || !('ask' in value)) return undefined;
  if (typeof value.ask !== 'string' || value.ask === '' || value.ask.length > MAX_ASK_ID_CHARS) return undefined;
  const label: SealedAnswerLabel = { ask: value.ask };
  if ('actionId' in value && value.actionId !== undefined) {
    if (typeof value.actionId !== 'string') return undefined;
    label.actionId = value.actionId;
  }
  if ('exit' in value && value.exit !== undefined) {
    if (value.exit !== true) return undefined;
    label.exit = true;
  }
  return label;
};

/**
 * Decrypt a push body sealed by `encryptPushBodyForDevices` (any client's
 * twin of it) for this device: `body` is the JSON `{ ciphertext, iv }`
 * envelope, the message key comes out of this device's `deviceKeyMap` slot.
 * Returns the `{ title, body, url }` the sender put in, the `cmd` label of a
 * sealed command, the `ask` / `answer` label of a sealed question / answer and
 * the `files` list and the `context` summary — each only when well formed. `context` is read from any body;
 * whether it belongs there (a question) is the caller's to decide.
 */
export const decryptPushBodyForDevice = async (
  body: string,
  entryJson: string,
  senderPublicKeyRaw: string,
): Promise<{
  title?: string;
  body?: string;
  url?: string;
  cmd?: SealedCommandLabel;
  ask?: SealedAskLabel;
  answer?: SealedAnswerLabel;
  files?: SealedFileMeta[];
  keys?: string[];
  ifPrompt?: string;
  context?: SealedAskContext;
}> => {
  const envelope = JSON.parse(body) as { ciphertext?: unknown; iv?: unknown }; // fields are type-checked on the next line
  if (typeof envelope.ciphertext !== 'string' || typeof envelope.iv !== 'string') {
    throw new Error('push body is not a { ciphertext, iv } envelope');
  }
  const rawKey = await unwrapDeviceKeyRaw(entryJson, senderPublicKeyRaw);
  const messageKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromBase64(envelope.iv)) },
    messageKey,
    fromBase64(envelope.ciphertext),
  );
  // A SyntaxError from JSON.parse quotes the start of the text it could not read, and this text
  // is authenticated plaintext: the message must not carry it. Same for the TypeError of `null`.
  let parsed: { title?: unknown; body?: unknown; url?: unknown; cmd?: unknown; ask?: unknown; answer?: unknown; files?: unknown; keys?: unknown; ifPrompt?: unknown; context?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as typeof parsed;
  } catch {
    throw new Error('sealed body is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('sealed body is not a JSON object');
  // Every field is type-checked below; a wrong shape is dropped, not trusted.
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return { title: str(parsed.title), body: str(parsed.body), url: str(parsed.url), cmd: commandLabel(parsed.cmd), ask: askLabel(parsed.ask), answer: answerLabel(parsed.answer), files: fileMetas(parsed.files), keys: sealedKeys(parsed.keys), ifPrompt: str(parsed.ifPrompt), context: askContext(parsed.context) };
};

// ─── Comparing device keys ───

/** DER header of a P-256 SPKI whose key is an uncompressed point; the 65-byte X9.63 point follows it. */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const P256_POINT_BYTES = 65;

/**
 * Whether two strings are the same device public key (twin of the cli's
 * `samePublicKey`). A device key has exactly one spelling — standard padded
 * Base64 of the 91-byte SPKI with an uncompressed point, what WebCrypto's
 * `exportKey('spki')` and the app write — so two keys are the same exactly
 * when their strings are. A string in any other spelling equals nothing,
 * itself included.
 */
export const samePublicKey = (a: string, b: string): boolean => {
  if (a !== b) return false;
  const der = Buffer.from(a, 'base64');
  return der.length === P256_SPKI_PREFIX.length + P256_POINT_BYTES
    && der.subarray(0, P256_SPKI_PREFIX.length).equals(P256_SPKI_PREFIX)
    && der[P256_SPKI_PREFIX.length] === 0x04
    && der.toString('base64') === a;
};

/**
 * The x coordinate of a device key's point, in hex (twin of the cli's `publicKeySender`): what the listener counts
 * sealed command numbers by in the trust file's `commandKeys`. null for a string that is not a device key.
 */
export const publicKeySender = (spkiBase64: string): string | null => {
  if (!samePublicKey(spkiBase64, spkiBase64)) return null;
  const point = P256_SPKI_PREFIX.length;
  return Buffer.from(spkiBase64, 'base64').subarray(point + 1, point + 33).toString('hex');
};
