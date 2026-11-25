import { describe, it, expect } from 'vitest';
import { createHash, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chunkedSealedSize, FILE_CHUNK_CAPABILITY, needsChunks, sealChunks, unableToOpenChunks, WHOLE_OPEN_BYTES } from './file-chunks.js';

// Copied from hwipit/cli src/file-chunk.vectors.json at cli commit 4bc9027: the apps read the same file.
const VECTORS = JSON.parse(readFileSync(new URL('./file-chunk.vectors.json', import.meta.url), 'utf8')) as {
  cases: { name: string; key: string; prefix: string; chunk: number; plainLength: number; sealedLength: number; sealedSha256: string; sealed?: string }[];
};

/** Byte i of a vector's plaintext is (i * 31 + 7) & 0xff. */
const pattern = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);

describe('sealChunks', () => {
  for (const c of VECTORS.cases) {
    it(`seals the vector "${c.name}" byte for byte`, () => {
      const sealed = sealChunks(pattern(c.plainLength), Buffer.from(c.key, 'hex'), Buffer.from(c.prefix, 'hex'), c.chunk);
      expect(sealed.length).toBe(c.sealedLength);
      expect(sealed.length).toBe(chunkedSealedSize(c.plainLength, c.chunk));
      if (c.sealed) expect(sealed.toString('hex')).toBe(c.sealed);
      expect(createHash('sha256').update(sealed).digest('hex')).toBe(c.sealedSha256);
    });
  }

  it('opens back piece by piece with the nonce prefix ‖ index ‖ last', () => {
    const key = randomBytes(32);
    const prefix = randomBytes(7);
    const plain = randomBytes(40);
    const sealed = sealChunks(plain, key, prefix, 16);
    const pieces = [sealed.subarray(0, 32), sealed.subarray(32, 64), sealed.subarray(64)];
    const opened = pieces.map((piece, index) => {
      const nonce = Buffer.concat([prefix, Buffer.from([0, 0, 0, index, index === 2 ? 1 : 0])]);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(piece.subarray(piece.length - 16));
      return Buffer.concat([decipher.update(piece.subarray(0, piece.length - 16)), decipher.final()]);
    });
    expect(Buffer.concat(opened)).toEqual(plain);
  });

  it('refuses an empty file and a prefix of the wrong size', () => {
    expect(() => sealChunks(new Uint8Array(0), randomBytes(32), randomBytes(7))).toThrow();
    expect(() => sealChunks(new Uint8Array(1), randomBytes(32), randomBytes(12))).toThrow();
  });
});

describe('needsChunks', () => {
  it('is over what a phone opens sealed whole, tag included', () => {
    expect(needsChunks(WHOLE_OPEN_BYTES - 16)).toBe(false);
    expect(needsChunks(WHOLE_OPEN_BYTES - 15)).toBe(true);
  });
});

describe('unableToOpenChunks', () => {
  const opens = { capabilities: [FILE_CHUNK_CAPABILITY], publicKey: 'k' };
  const devices = [
    { deviceId: 'dev_ios_a', nickname: 'iPhone', ...opens },
    { deviceId: 'dev_android_b', nickname: 'Pixel', publicKey: 'k' },
    { deviceId: 'dev_listener_me', publicKey: 'k' },
    { deviceId: 'dev_ios_keyless' },
  ];

  it('to all devices: names every keyed device but this machine that does not list the format', () => {
    expect(unableToOpenChunks(devices, undefined, 'dev_listener_me')).toEqual(['Pixel']);
    expect(unableToOpenChunks(devices.map((d) => ({ ...d, capabilities: [FILE_CHUNK_CAPABILITY] })), undefined, 'dev_listener_me')).toEqual([]);
  });

  it('to one device: only that one counts, and one not listed cannot', () => {
    expect(unableToOpenChunks(devices, 'dev_ios_a', 'dev_listener_me')).toEqual([]);
    expect(unableToOpenChunks(devices, 'dev_android_b', 'dev_listener_me')).toEqual(['Pixel']);
    expect(unableToOpenChunks(devices, 'dev_gone', 'dev_listener_me')).toEqual(['dev_gone']);
  });

  it('with no device to go to, none can', () => {
    expect(unableToOpenChunks([{ deviceId: 'dev_listener_me', publicKey: 'k' }], undefined, 'dev_listener_me')).toEqual(['no device']);
  });
});
