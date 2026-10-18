/**
 * The files the phone attached to the answer of a sealed `hwip_ask` (twin of the cli's
 * `hwip ask`, which saves them with the listener's `downloadAttachments`).
 *
 * Each file is sealed like a command's attachment: the wire entry on the response
 * carries the fileKey, the iv and this machine's wrapped key, and the answer's seal
 * names the file — its real name, type and size, matched to the wire entry by iv. Only
 * files the seal names are opened, so the relay can neither add one nor rename one; a
 * file the seal names that is missing or does not open is reported back, never
 * dropped in silence, and the answer itself still goes to the agent.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { decryptFileForDevice, type SealedFileMeta } from './crypto.js';

/** `~/.hwip/attachments`, where the listener also saves a command's files. */
export const ATTACHMENTS_DIR = join(homedir(), '.hwip', 'attachments');

/** The most one answer file is read into memory at: a phone attachment, not a disk image. */
export const MAX_ANSWER_FILE_BYTES = 256 * 1024 * 1024;

export interface SavedAnswerFiles {
  /** Absolute paths of the files saved, in the seal's order. */
  paths: string[];
  /** One `<name>: <why>` per file the seal names that was not saved. */
  missing: string[];
}

export interface AnswerFileDeps {
  /** This machine's device id: its slot in each file's key map. */
  selfId: string;
  /** The answering phone's key, already checked against the seal (`openAnswer`). */
  senderPublicKey: string;
  /** fileKey → the sealed bytes. */
  fetchBytes: (fileKey: string) => Promise<Buffer>;
  /** Where the event's folder goes; `ATTACHMENTS_DIR` outside tests. */
  dir?: string;
  open?: typeof decryptFileForDevice;
}

/** A wire file, read for one device: its fileKey, iv, and that device's wrapped key. */
interface WireFile {
  fileKey: string;
  iv: string;
  slot: string;
}

const wireFileFor = (selfId: string) => (value: unknown): WireFile[] => {
  if (typeof value !== 'object' || value === null) return [];
  const { fileKey, iv, deviceKeyMap } = value as { fileKey?: unknown; iv?: unknown; deviceKeyMap?: unknown };
  if (typeof fileKey !== 'string' || typeof iv !== 'string' || typeof deviceKeyMap !== 'object' || deviceKeyMap === null) return [];
  // Relay JSON being parsed: the map is read for this one key and its value checked below.
  const slot: unknown = (deviceKeyMap as { [id: string]: unknown })[selfId];
  return typeof slot === 'string' ? [{ fileKey, iv, slot }] : [];
};

/** A file name's longest form here, in UTF-8 bytes: under the 255-byte limit of common filesystems. */
const MAX_NAME_BYTES = 200;

/** The longest start of `text` within `bytes` UTF-8 bytes, cut between code points. */
const fitBytes = (text: string, bytes: number): string => {
  let out = '';
  let used = 0;
  for (const point of text) {
    used += Buffer.byteLength(point);
    if (used > bytes) break;
    out += point;
  }
  return out;
};

/** A name that stays one segment inside the event's folder. */
const safeName = (name: string, fallback: string): string => {
  const base = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  if (base === '' || base === '.' || base === '..') return fallback;
  if (Buffer.byteLength(base) <= MAX_NAME_BYTES) return base;
  // Cut from the stem, so the extension that says what the file is stays.
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : '';
  return fitBytes(base.slice(0, base.length - ext.length), MAX_NAME_BYTES - Buffer.byteLength(ext)) + ext;
};

/** `name.ext`, then `name-1.ext`, … — two answers' `image.png` are two files. */
const freeName = (taken: Set<string>, name: string): string => {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
};

export const saveAnswerFiles = async (
  eventId: string,
  wire: unknown,
  metas: SealedFileMeta[],
  deps: AnswerFileDeps,
): Promise<SavedAnswerFiles> => {
  const wireFiles = Array.isArray(wire) ? wire.flatMap(wireFileFor(deps.selfId)) : [];
  const folder = join(deps.dir ?? ATTACHMENTS_DIR, safeName(eventId, 'answer'));
  const open = deps.open ?? decryptFileForDevice;
  const taken = new Set<string>();
  const saved: SavedAnswerFiles = { paths: [], missing: [] };
  for (const [i, meta] of metas.entries()) {
    const name = safeName(meta.name, `file-${i}`);
    // Sealed in pieces: a file too large to be opened whole here.
    if (meta.chunk !== undefined) {
      saved.missing.push(`${name}: too large (sealed in chunks)`);
      continue;
    }
    const file = wireFiles.find((f) => f.iv === meta.iv);
    if (!file) {
      saved.missing.push(`${name}: not delivered`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await deps.fetchBytes(file.fileKey);
    } catch {
      saved.missing.push(`${name}: download failed`);
      continue;
    }
    let opened: Buffer;
    try {
      opened = await open(bytes, file.iv, file.slot, deps.senderPublicKey);
    } catch {
      saved.missing.push(`${name}: did not open`);
      continue;
    }
    // Padded before sealing: cut back to the size the seal gives.
    const size = Number.isSafeInteger(meta.size) && meta.size >= 0 ? meta.size : opened.length;
    const abs = join(folder, freeName(taken, name));
    try {
      mkdirSync(folder, { recursive: true });
      writeFileSync(abs, opened.subarray(0, size));
    } catch {
      saved.missing.push(`${name}: not saved`);
      continue;
    }
    saved.paths.push(abs);
  }
  return saved;
};
