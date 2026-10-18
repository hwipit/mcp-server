import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A phone's sealed answer file, written out with WebCrypto as the app seals one (Envelope.sealFile):
// AES-GCM over the padded bytes, the file key wrapped for the asker with ECDH(phone, asker).
const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };
interface KeyPair { publicKey: string; privateKey: string }
const KEYS = (JSON.parse(readFileSync(new URL('./crypto-labels.vectors.json', import.meta.url), 'utf8')) as {
  keys: { sender: KeyPair; recipient: KeyPair };
}).keys; // own fixture file
const ASKER = KEYS.sender;
const PHONE = KEYS.recipient;

const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');
const b64 = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64');

const sealFile = async (bytes: Buffer, fileKey: string) => {
  const privateKey = await crypto.subtle.importKey('pkcs8', unb64(PHONE.privateKey), ECDH, false, ['deriveKey']);
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const shared = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: await crypto.subtle.importKey('spki', unb64(ASKER.publicKey), ECDH, false, []) },
    privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const keyIv = crypto.getRandomValues(new Uint8Array(12));
  const slot = JSON.stringify({ encryptedKey: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, shared, await crypto.subtle.exportKey('raw', key))), keyIv: b64(keyIv) });
  return {
    ciphertext,
    wire: { fileKey, fileName: 'file', fileType: 'application/octet-stream', fileSize: ciphertext.length, iv: b64(iv), deviceKeyMap: { dev_laptop: slot } },
  };
};

let TMP: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'answer-files-'));
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

/** This machine is the asker: its device keys are ASKER's. */
const asAsker = async () => {
  const home = mkdtempSync(join(TMP, 'home-'));
  mkdirSync(join(home, '.hwip'), { recursive: true });
  writeFileSync(join(home, '.hwip', 'device-keys.json'), JSON.stringify(ASKER));
  process.env.HOME = home;
  vi.resetModules();
  await (await import('./crypto.js')).initCrypto();
  return import('./answer-files.js');
};

describe('saveAnswerFiles — answer files', () => {
  it('opens a sealed file, cuts the padding and saves it under its sealed name', async () => {
    const { saveAnswerFiles } = await asAsker();
    const { ciphertext, wire } = await sealFile(Buffer.from('hello\0\0\0'), 'user/u/f1');
    const dir = join(TMP, 'attachments');

    const saved = await saveAnswerFiles('hevt_1', [wire], [{ iv: wire.iv, name: 'note.txt', type: 'text/plain', size: 5 }], {
      selfId: 'dev_laptop', senderPublicKey: PHONE.publicKey, dir, fetchBytes: async () => ciphertext,
    });

    expect(saved).toEqual({ paths: [join(dir, 'hevt_1', 'note.txt')], missing: [] });
    expect(readFileSync(saved.paths[0]!, 'utf8')).toBe('hello');
  });

  it('reports a listed file the relay dropped, and saves no file the seal does not name', async () => {
    const { saveAnswerFiles } = await asAsker();
    const named = await sealFile(Buffer.from('a'), 'user/u/named');
    const extra = await sealFile(Buffer.from('b'), 'user/u/extra');
    const dir = join(TMP, 'attachments');

    const saved = await saveAnswerFiles('hevt_1', [extra.wire], [{ iv: named.wire.iv, name: 'shot.png', type: 'image/png', size: 1 }], {
      selfId: 'dev_laptop', senderPublicKey: PHONE.publicKey, dir, fetchBytes: async () => extra.ciphertext,
    });

    expect(saved.paths).toEqual([]);
    expect(saved.missing).toEqual(['shot.png: not delivered']);
  });

  it('keeps a hostile name inside the event folder', async () => {
    const { saveAnswerFiles } = await asAsker();
    const { ciphertext, wire } = await sealFile(Buffer.from('x'), 'user/u/f1');
    const dir = join(TMP, 'attachments');

    const saved = await saveAnswerFiles('hevt_1', [wire], [{ iv: wire.iv, name: '../../escape.sh', type: 'text/plain', size: 1 }], {
      selfId: 'dev_laptop', senderPublicKey: PHONE.publicKey, dir, fetchBytes: async () => ciphertext,
    });

    expect(saved.paths).toHaveLength(1);
    expect(saved.paths[0]!.startsWith(join(dir, 'hevt_1') + '/')).toBe(true);
    expect(readdirSync(join(dir, 'hevt_1'))).toEqual(['escape.sh']);
  });

  it('saves the files that came and reports the one whose download failed', async () => {
    const { saveAnswerFiles } = await asAsker();
    const ok = await sealFile(Buffer.from('ok'), 'user/u/ok');
    const bad = await sealFile(Buffer.from('no'), 'user/u/bad');
    const dir = join(TMP, 'attachments');

    const saved = await saveAnswerFiles('hevt_1', [ok.wire, bad.wire], [
      { iv: ok.wire.iv, name: 'a.txt', type: 'text/plain', size: 2 },
      { iv: bad.wire.iv, name: 'b.txt', type: 'text/plain', size: 2 },
    ], {
      selfId: 'dev_laptop', senderPublicKey: PHONE.publicKey, dir,
      fetchBytes: async (key) => { if (key === 'user/u/bad') throw new Error('download 403'); return ok.ciphertext; },
    });

    expect(saved).toEqual({ paths: [join(dir, 'hevt_1', 'a.txt')], missing: ['b.txt: download failed'] });
  });

  it('reports a file it could not write, and still saves the rest', async () => {
    const { saveAnswerFiles } = await asAsker();
    const { ciphertext, wire } = await sealFile(Buffer.from('x'), 'user/u/f1');
    // The event folder's place is taken by a file: nothing can be written under it.
    const dir = join(TMP, 'attachments');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hevt_1'), 'in the way');

    const saved = await saveAnswerFiles('hevt_1', [wire], [{ iv: wire.iv, name: 'a.txt', type: 'text/plain', size: 1 }], {
      selfId: 'dev_laptop', senderPublicKey: PHONE.publicKey, dir, fetchBytes: async () => ciphertext,
    });

    expect(saved).toEqual({ paths: [], missing: ['a.txt: not saved'] });
  });

  it('cuts an over-long name, keeping its extension', async () => {
    const { saveAnswerFiles } = await asAsker();
    const { ciphertext, wire } = await sealFile(Buffer.from('x'), 'user/u/f1');
    const dir = join(TMP, 'attachments');

    const saved = await saveAnswerFiles('hevt_1', [wire], [{ iv: wire.iv, name: `${'가'.repeat(300)}.png`, type: 'image/png', size: 1 }], {
      selfId: 'dev_laptop', senderPublicKey: PHONE.publicKey, dir, fetchBytes: async () => ciphertext,
    });

    const [name] = readdirSync(join(dir, 'hevt_1'));
    expect(saved.missing).toEqual([]);
    expect(Buffer.byteLength(name!)).toBeLessThanOrEqual(200);
    expect(name).toBe(`${'가'.repeat(65)}.png`);
    expect(name!.endsWith('.png')).toBe(true);
  });

  it('reports a file sealed in chunks without fetching it', async () => {
    const { saveAnswerFiles } = await asAsker();
    const { wire } = await sealFile(Buffer.from('x'), 'user/u/f1');
    const fetchBytes = vi.fn(async () => Buffer.alloc(0));

    const saved = await saveAnswerFiles('hevt_1', [wire], [{ iv: wire.iv, name: 'big.mov', type: 'video/quicktime', size: 1, chunk: 4_194_304 }], {
      selfId: 'dev_laptop', senderPublicKey: PHONE.publicKey, dir: join(TMP, 'attachments'), fetchBytes,
    });

    expect(saved).toEqual({ paths: [], missing: ['big.mov: too large (sealed in chunks)'] });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('asks for no more of a file than its seal says it holds, padded, and keeps it to this user', async () => {
    const { saveAnswerFiles, answerFileBound, MAX_ANSWER_FILE_BYTES } = await asAsker();
    const { ciphertext, wire } = await sealFile(Buffer.from('tiny'), 'user/u/tiny');
    const fetchBytes = vi.fn(async () => ciphertext);
    const dir = join(TMP, 'bound');
    const saved = await saveAnswerFiles('evt_bound', [wire], [{ iv: wire.iv, name: 'tiny.txt', type: 'text/plain', size: 4 }], {
      selfId: 'dev_laptop', senderPublicKey: PHONE.publicKey, dir, fetchBytes,
    });
    expect(fetchBytes).toHaveBeenCalledWith('user/u/tiny', 4 + 16);
    expect(statSync(saved.paths[0]!).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'evt_bound')).mode & 0o777).toBe(0o700);
    expect(answerFileBound(9)).toBe(10 + 16);
    expect(answerFileBound(Number.NaN)).toBe(MAX_ANSWER_FILE_BYTES);
  });
});
