/**
 * A file sealed in chunks (`file-chunk-v1`, cli `src/file-crypto.ts`): the format for a file too large for a phone to
 * open in one piece. The bytes are cut into `FILE_CHUNK_BYTES` pieces (the last one shorter or equal, never empty), and
 * each is sealed on its own with AES-256-GCM under the file key, nonce = prefix (7 random bytes) ‖ index (u32,
 * big-endian) ‖ last (1 or 0). The file is the pieces `ciphertext ‖ tag` end to end, its `iv` is the prefix, and the
 * sealed file list's `chunk` says the file is in this format.
 */
import { createCipheriv } from 'node:crypto';

export const FILE_CHUNK_BYTES = 1_048_576;
export const FILE_CHUNK_PREFIX_BYTES = 7;
/** What a device lists (`capabilities` on its record) when it opens this format. */
export const FILE_CHUNK_CAPABILITY = 'file-chunk-v1';
const GCM_TAG_BYTES = 16;

/**
 * The most a file sealed whole may measure sealed: what the phones hold in memory to open one (iOS
 * `AttachmentLoader.maxEncryptedBytes`, Android `SealedSend.MAX_SEALED_FILE_BYTES`). A larger one goes in chunks.
 */
export const WHOLE_OPEN_BYTES = 50 * 1024 * 1024;

/** Whether a file of `size` plain bytes is over what a phone opens sealed whole. */
export const needsChunks = (size: number): boolean => size + GCM_TAG_BYTES > WHOLE_OPEN_BYTES;

/** What `size` plain bytes measure sealed in chunks. */
export const chunkedSealedSize = (size: number, chunk = FILE_CHUNK_BYTES): number =>
  size + GCM_TAG_BYTES * Math.ceil(size / chunk);

/** `plain` sealed in chunks under `key` (32 bytes) and `prefix` (7 bytes). */
export const sealChunks = (plain: Uint8Array, key: Uint8Array, prefix: Uint8Array, chunk = FILE_CHUNK_BYTES): Buffer => {
  if (plain.byteLength === 0) throw new Error('an empty file is not sealed in chunks');
  if (prefix.byteLength !== FILE_CHUNK_PREFIX_BYTES) throw new Error(`a chunk prefix is ${FILE_CHUNK_PREFIX_BYTES} bytes`);
  const count = Math.ceil(plain.byteLength / chunk);
  // The index is four bytes of the nonce.
  if (count > 0xffff_ffff) throw new Error('too many chunks');
  const out = Buffer.allocUnsafe(chunkedSealedSize(plain.byteLength, chunk));
  const nonce = Buffer.alloc(FILE_CHUNK_PREFIX_BYTES + 5);
  Buffer.from(prefix).copy(nonce);
  let at = 0;
  for (let index = 0; index < count; index++) {
    nonce.writeUInt32BE(index, FILE_CHUNK_PREFIX_BYTES);
    nonce[FILE_CHUNK_PREFIX_BYTES + 4] = index === count - 1 ? 1 : 0;
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const piece = plain.subarray(index * chunk, Math.min((index + 1) * chunk, plain.byteLength));
    at += cipher.update(piece).copy(out, at);
    at += cipher.final().copy(out, at);
    at += cipher.getAuthTag().copy(out, at);
  }
  return out;
};

/** A device as `GET /devices` lists it, for the chunk check. */
export interface ChunkAudienceDevice {
  deviceId: string;
  nickname?: string;
  publicKey?: string;
  capabilities?: string[];
}

/**
 * The devices a push to `target` goes to that cannot open a file sealed in chunks, by name; empty when every one
 * can (iOS `Sender.sealedLimit`). To all devices that is every keyed device but this machine; to one device, that
 * one, and a target not in the list reads as one that cannot.
 */
export const unableToOpenChunks = (devices: ChunkAudienceDevice[], target: string | undefined, selfId: string): string[] => {
  const goesTo = target
    ? (devices.find((d) => d.deviceId === target) ? devices.filter((d) => d.deviceId === target) : [{ deviceId: target }])
    : devices.filter((d) => d.publicKey && d.deviceId !== selfId);
  if (goesTo.length === 0) return ['no device'];
  return goesTo.filter((d) => !d.capabilities?.includes(FILE_CHUNK_CAPABILITY)).map((d) => d.nickname || d.deviceId);
};
