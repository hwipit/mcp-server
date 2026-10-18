import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushBodyInput, SealedAskContext } from './crypto.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The sealed-body labels of an ask round trip (F1): `ask` on the question,
// `answer` on the reply, `cmd.from` on a command, `files` on an attachment.
// crypto-labels.vectors.json holds envelopes built from fixed keys, message
// key and IVs. The file is a byte-for-byte copy of the cli's (`src/crypto-labels.vectors.json`
// in hwip cli); the cli test regenerates it, the iOS app opens it too.

const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };
const VECTOR_URL = new URL('./crypto-labels.vectors.json', import.meta.url);

interface KeyPair { publicKey: string; privateKey: string }
interface Vector {
    name: string;
    content: PushBodyInput & { context?: SealedAskContext };
    /** The reader drops the `context` of this vector (the rest of the question still opens). */
    contextDropped?: true;
    body: string;
    entry: string;
    senderPublicKey: string;
}
interface VectorFile {
    note: string;
    keys: { sender: KeyPair; recipient: KeyPair; stranger: KeyPair };
    messageKey: string;
    iv: string;
    keyIv: string;
    vectors: Vector[];
}

const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');
const b64 = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64');
// The file is this repo's own fixture, pinned by the sha256 below.
const readVectors = (): VectorFile => JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as VectorFile; // own fixture file

/** Seal `plaintext` the way `encryptPushBodyForDevices` does, with the fixed message key and IVs of the vector file. */
const sealFixed = async (
    file: VectorFile,
    plaintext: string,
    sender: KeyPair,
    recipient: KeyPair,
): Promise<{ body: string; entry: string; senderPublicKey: string }> => {
    const privateKey = await crypto.subtle.importKey('pkcs8', unb64(sender.privateKey), ECDH, false, ['deriveKey']);
    const publicKey = await crypto.subtle.importKey('spki', unb64(recipient.publicKey), ECDH, false, []);
    const shared = await crypto.subtle.deriveKey({ name: 'ECDH', public: publicKey }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const messageKey = await crypto.subtle.importKey('raw', unb64(file.messageKey), { name: 'AES-GCM' }, true, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, messageKey, new TextEncoder().encode(plaintext));
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unb64(file.keyIv) }, shared, unb64(file.messageKey));
    return {
        body: JSON.stringify({ ciphertext: b64(ciphertext), iv: file.iv }),
        entry: JSON.stringify({ encryptedKey: b64(wrapped), keyIv: file.keyIv }),
        senderPublicKey: sender.publicKey,
    };
};

let TMP: string;
const originalHome = process.env.HOME;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'mcp-crypto-labels-'));
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
});

/** A fresh module graph whose device key is `keys`, as if this host were that device. */
const asDevice = async (keys: KeyPair): Promise<typeof import('./crypto.js')> => {
    const home = mkdtempSync(join(TMP, 'home-'));
    mkdirSync(join(home, '.hwip'), { recursive: true });
    writeFileSync(join(home, '.hwip', 'device-keys.json'), JSON.stringify(keys));
    process.env.HOME = home;
    vi.resetModules();
    const mod = await import('./crypto.js');
    await mod.initCrypto();
    return mod;
};

/** sha256 of the cli's vector file this copy was taken from. When the cli regenerates it, copy the file again and update this value. */
const CLI_VECTORS_SHA256 = '329d81c4c8c3b947b9baa0644086d15c6d5380d49812edd65511a7f2530d718c';

it('holds the cli vector file unchanged', () => {
    expect(createHash('sha256').update(readFileSync(VECTOR_URL)).digest('hex')).toBe(CLI_VECTORS_SHA256);
});

describe('label vectors', () => {
    it('are the envelopes the fixed keys, message key and IVs produce', async () => {
        const file = readVectors();
        expect(file.vectors.map((v) => v.name)).toEqual([
            'question',
            'question-with-files',
            'question-with-context',
            'question-with-context-path-128-bytes',
            'question-with-context-path-129-bytes',
            'answer',
            'command',
            'command-with-keys',
        ]);
        for (const vector of file.vectors) {
            const again = await sealFixed(file, JSON.stringify(vector.content), file.keys.sender, file.keys.recipient);
            expect({ name: vector.name, ...again }).toEqual({ name: vector.name, body: vector.body, entry: vector.entry, senderPublicKey: vector.senderPublicKey });
        }
    });

    it('open on the recipient device with every label value intact', async () => {
        const file = readVectors();
        const device = await asDevice(file.keys.recipient);
        for (const vector of file.vectors) {
            const opened = await device.decryptPushBodyForDevice(vector.body, vector.entry, vector.senderPublicKey);
            const { title, body, url, cmd, ask, answer, files, keys, ifPrompt, context } = vector.content;
            expect({ name: vector.name, ...opened }).toEqual({ name: vector.name, title, body, url, cmd, ask, answer, files, keys, ifPrompt, context: vector.contextDropped ? undefined : context });
        }
    });

    it('reject a single flipped byte in the ciphertext, either IV or the wrapped key', async () => {
        const file = readVectors();
        const device = await asDevice(file.keys.recipient);
        const vector = file.vectors.find((v) => v.name === 'question')!;
        const flip = (value: string): string => {
            const bytes = unb64(value);
            bytes[0] = bytes[0]! ^ 1;
            return b64(bytes);
        };
        const envelope = JSON.parse(vector.body) as { ciphertext: string; iv: string };
        const entry = JSON.parse(vector.entry) as { encryptedKey: string; keyIv: string };
        const tampered = [
            { body: JSON.stringify({ ...envelope, ciphertext: flip(envelope.ciphertext) }), entry: vector.entry },
            { body: JSON.stringify({ ...envelope, iv: flip(envelope.iv) }), entry: vector.entry },
            { body: vector.body, entry: JSON.stringify({ ...entry, encryptedKey: flip(entry.encryptedKey) }) },
            { body: vector.body, entry: JSON.stringify({ ...entry, keyIv: flip(entry.keyIv) }) },
        ];
        for (const t of tampered) {
            await expect(device.decryptPushBodyForDevice(t.body, t.entry, vector.senderPublicKey)).rejects.toThrow();
        }
    });

    it('reject a device the envelope was not sealed for, and a sender key that did not seal it', async () => {
        const file = readVectors();
        const vector = file.vectors.find((v) => v.name === 'question')!;

        const stranger = await asDevice(file.keys.stranger);
        await expect(stranger.decryptPushBodyForDevice(vector.body, vector.entry, vector.senderPublicKey)).rejects.toThrow();

        const recipient = await asDevice(file.keys.recipient);
        await expect(recipient.decryptPushBodyForDevice(vector.body, vector.entry, file.keys.stranger.publicKey)).rejects.toThrow();
    });
});

describe('encryptPushBodyForDevices with labels', () => {
    it('seals a question and an answer the recipient device opens', async () => {
        const file = readVectors();
        const sender = await asDevice(file.keys.sender);
        const ask = { id: 'abc', device: 'dev_laptop', actions: [{ id: 'ok', label: 'OK' }], placeholder: 'why?' };
        const answer = { ask: 'abc', actionId: 'ok', exit: true as const };

        const question = await sender.encryptPushBodyForDevices({ title: 'T', body: 'B', ask }, [{ deviceId: 'dev_phone', publicKey: file.keys.recipient.publicKey }]);
        const reply = await sender.encryptPushBodyForDevices({ body: 'text', answer }, [{ deviceId: 'dev_phone', publicKey: file.keys.recipient.publicKey }]);

        const recipient = await asDevice(file.keys.recipient);
        const openedQuestion = await recipient.decryptPushBodyForDevice(question.body, question.deviceKeyMap.dev_phone!, question.senderPublicKey);
        const openedReply = await recipient.decryptPushBodyForDevice(reply.body, reply.deviceKeyMap.dev_phone!, reply.senderPublicKey);
        expect(openedQuestion).toMatchObject({ title: 'T', body: 'B', ask });
        expect(openedQuestion.answer).toBeUndefined();
        expect(openedReply).toMatchObject({ body: 'text', answer });
        expect(openedReply.ask).toBeUndefined();
    });

    it('seals a command label with `from` and an attachment list the recipient device opens', async () => {
        const file = readVectors();
        const sender = await asDevice(file.keys.sender);
        const cmd = { n: 9, session: 'hwip-a', device: 'dev_laptop', from: 'dev_other' };
        const files = [{ iv: 'AAECAwQFBgcICQoL', name: 'response.md', type: 'text/markdown', size: 12 }];

        const sealed = await sender.encryptPushBodyForDevices({ body: 'ls', cmd, files }, [{ deviceId: 'dev_phone', publicKey: file.keys.recipient.publicKey }]);

        const recipient = await asDevice(file.keys.recipient);
        const opened = await recipient.decryptPushBodyForDevice(sealed.body, sealed.deviceKeyMap.dev_phone!, sealed.senderPublicKey);
        expect(opened).toMatchObject({ body: 'ls', cmd, files });
    });

    it('keeps the plaintext JSON of a label-free input exactly what it was', async () => {
        const file = readVectors();
        const sender = await asDevice(file.keys.sender);
        const sealed = await sender.encryptPushBodyForDevices({ title: 'T', body: 'B' }, [{ deviceId: 'dev_phone', publicKey: file.keys.recipient.publicKey }]);

        const privateKey = await crypto.subtle.importKey('pkcs8', unb64(file.keys.recipient.privateKey), ECDH, false, ['deriveKey']);
        const senderKey = await crypto.subtle.importKey('spki', unb64(sealed.senderPublicKey), ECDH, false, []);
        const shared = await crypto.subtle.deriveKey({ name: 'ECDH', public: senderKey }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        const entry = JSON.parse(sealed.deviceKeyMap.dev_phone!) as { encryptedKey: string; keyIv: string };
        const rawKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(entry.keyIv) }, shared, unb64(entry.encryptedKey));
        const messageKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
        const envelope = JSON.parse(sealed.body) as { ciphertext: string; iv: string };
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) }, messageKey, unb64(envelope.ciphertext));

        expect(new TextDecoder().decode(plaintext)).toBe('{"title":"T","body":"B"}');
    });
});

describe('decryptPushBodyForDevice label parsing', () => {
    const openContent = async (content: unknown): Promise<Awaited<ReturnType<typeof import('./crypto.js').decryptPushBodyForDevice>>> => {
        const file = readVectors();
        const sealed = await sealFixed(file, JSON.stringify(content), file.keys.sender, file.keys.recipient);
        const device = await asDevice(file.keys.recipient);
        return device.decryptPushBodyForDevice(sealed.body, sealed.entry, sealed.senderPublicKey);
    };
    const actions = (n: number): { id: string; label: string }[] => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, label: `A${i}` }));

    it('keeps a question with ten actions and drops one with eleven', async () => {
        expect((await openContent({ ask: { id: 'q', device: 'd', actions: actions(10) } })).ask?.actions).toHaveLength(10);
        expect((await openContent({ ask: { id: 'q', device: 'd', actions: actions(11) } })).ask).toBeUndefined();
    });

    it('drops the whole ask label for an action id over 64 or a label over 100 characters', async () => {
        expect((await openContent({ ask: { id: 'q', device: 'd', actions: [{ id: 'x'.repeat(64), label: 'y'.repeat(100) }] } })).ask).toBeDefined();
        expect((await openContent({ ask: { id: 'q', device: 'd', actions: [{ id: 'x'.repeat(65), label: 'ok' }] } })).ask).toBeUndefined();
        expect((await openContent({ ask: { id: 'q', device: 'd', actions: [{ id: 'x', label: 'y'.repeat(101) }] } })).ask).toBeUndefined();
    });

    it('drops labels of the wrong shape', async () => {
        expect((await openContent({ ask: { id: 'q' } })).ask).toBeUndefined();
        expect((await openContent({ ask: { id: 'q', device: 'd', placeholder: 3 } })).ask).toBeUndefined();
        expect((await openContent({ ask: { id: 'q', device: 'd', actions: [{ id: 'x', label: 'y', style: 1 }] } })).ask).toBeUndefined();
        expect((await openContent({ answer: { actionId: 'ok' } })).answer).toBeUndefined();
        expect((await openContent({ answer: { ask: 'q', exit: false } })).answer).toBeUndefined();
        expect((await openContent({ answer: { ask: 'q', actionId: 7 } })).answer).toBeUndefined();
        expect((await openContent({ cmd: { n: 1, session: 's', device: 'd', from: 5 } })).cmd).toBeUndefined();
    });

    it('drops a files list with a malformed entry', async () => {
        expect((await openContent({ files: [{ iv: 'a', name: 'n', type: 't', size: '3' }] })).files).toBeUndefined();
        expect((await openContent({ files: 'nope' })).files).toBeUndefined();
    });

    it('reads a command without `from` as before', async () => {
        expect((await openContent({ cmd: { n: 1, session: 's', device: 'd' } })).cmd).toEqual({ n: 1, session: 's', device: 'd' });
    });

    it('drops an ask label with an empty id, an over-long id or an odd device, and an answer with an empty or long `ask`', async () => {
        expect((await openContent({ ask: { id: '', device: 'd' } })).ask).toBeUndefined();
        expect((await openContent({ ask: { id: 'x'.repeat(129), device: 'd' } })).ask).toBeUndefined();
        expect((await openContent({ ask: { id: 'q', device: '' } })).ask).toBeUndefined();
        expect((await openContent({ ask: { id: 'q', device: 'dev laptop' } })).ask).toBeUndefined();
        expect((await openContent({ ask: { id: 'q', device: 'x'.repeat(65) } })).ask).toBeUndefined();
        expect((await openContent({ answer: { ask: '' } })).answer).toBeUndefined();
        expect((await openContent({ answer: { ask: 'x'.repeat(129) } })).answer).toBeUndefined();
    });
});

describe('encryptPushBodyForDevices ask limits', () => {
    it.each([
        ['eleven actions', { id: 'q', device: 'dev_laptop', actions: Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, label: `A${i}` })) }, 'a question takes at most 10 choices'],
        ['an action id over 64 characters', { id: 'q', device: 'dev_laptop', actions: [{ id: 'x'.repeat(65), label: 'ok' }] }, 'a choice id is over 64 characters'],
        ['an action label over 100 characters', { id: 'q', device: 'dev_laptop', actions: [{ id: 'x', label: 'y'.repeat(101) }] }, 'a choice label is over 100 characters'],
        ['an empty ask id', { id: '', device: 'dev_laptop' }, 'ask id must be 1 to 128 characters'],
        ['an ask id over 128 characters', { id: 'x'.repeat(129), device: 'dev_laptop' }, 'ask id must be 1 to 128 characters'],
        ['a device id that is not one', { id: 'q', device: 'dev laptop' }, 'ask device id is not a device id'],
    ])('refuses to seal a question with %s instead of sending one the reader would drop', async (_name, ask, message) => {
        const file = readVectors();
        const sender = await asDevice(file.keys.sender);
        await expect(sender.encryptPushBodyForDevices({ title: 'T', ask }, [{ deviceId: 'dev_phone', publicKey: file.keys.recipient.publicKey }]))
            .rejects.toThrow(message);
    });
});

describe('decryptPushBodyForDevice on a body that is not a JSON object', () => {
    const open = async (plaintext: string): Promise<unknown> => {
        const file = readVectors();
        const sealed = await sealFixed(file, plaintext, file.keys.sender, file.keys.recipient);
        const device = await asDevice(file.keys.recipient);
        return device.decryptPushBodyForDevice(sealed.body, sealed.entry, sealed.senderPublicKey).then(() => 'opened', (err: Error) => err.message);
    };

    it('fails with a fixed message that holds none of the plaintext', async () => {
        expect(await open('SECRET-TEXT-NOT-JSON')).toBe('sealed body is not JSON');
        expect(await open('null')).toBe('sealed body is not a JSON object');
        expect(await open('7')).toBe('sealed body is not a JSON object');
    });
});

const SUMMARY: SealedAskContext = {
    diff: 'ok',
    files: 3,
    added: 14,
    removed: 2,
    listed: [
        { path: 'src/ask.ts', status: 'M', added: 10, removed: 2 },
        { path: 'docs/한글.md', status: 'A', added: 4, removed: 0 },
        { path: 'assets/logo.png', status: '?', added: 0, removed: 0, binary: true },
    ],
    moreFiles: 0,
    screenLines: 31,
    masked: 1,
    cut: { diff: false, screen: true },
};

// The summary a question may carry (F3). Only a reader exists here; the cli's test holds the same cases against its own collector.
describe('the context summary of a question', () => {
    const open = async (context: unknown): Promise<Awaited<ReturnType<typeof import('./crypto.js').decryptPushBodyForDevice>>> => {
        const file = readVectors();
        const sealed = await sealFixed(
            file,
            JSON.stringify({ title: 'T', body: 'B', ask: { id: 'q', device: 'dev_laptop' }, context }),
            file.keys.sender,
            file.keys.recipient,
        );
        const device = await asDevice(file.keys.recipient);
        return device.decryptPushBodyForDevice(sealed.body, sealed.entry, sealed.senderPublicKey);
    };

    it('opens as it was sealed, and is absent from the vectors that carry none', async () => {
        expect((await open(SUMMARY)).context).toEqual(SUMMARY);

        const file = readVectors();
        const device = await asDevice(file.keys.recipient);
        for (const vector of file.vectors.filter((v) => v.content.context === undefined)) {
            const opened = await device.decryptPushBodyForDevice(vector.body, vector.entry, vector.senderPublicKey);
            expect({ name: vector.name, context: opened.context }).toEqual({ name: vector.name, context: undefined });
        }
    });

    it.each([
        ['a string', 'oops'],
        ['null', null],
        ['an array', []],
        ['an unknown diff state', { ...SUMMARY, diff: 'maybe' }],
        ['a negative count', { ...SUMMARY, added: -1 }],
        ['a fractional count', { ...SUMMARY, files: 1.5 }],
        ['a count that is a string', { ...SUMMARY, masked: '1' }],
        ['a missing count', { ...SUMMARY, moreFiles: undefined }],
        ['a count past the safe integers', { ...SUMMARY, files: 2 ** 53 }],
        ['a count of 1e300', { ...SUMMARY, files: 1e300 }],
        ['more than 20 listed files', { ...SUMMARY, listed: Array.from({ length: 21 }, (_, i) => ({ path: `f${i}`, status: 'M', added: 0, removed: 0 })) }],
        ['a listed path over 128 bytes', { ...SUMMARY, listed: [{ path: 'x'.repeat(129), status: 'M', added: 0, removed: 0 }] }],
        ['a listed path of 129 bytes in 43 UTF-16 units', { ...SUMMARY, listed: [{ path: '한'.repeat(43), status: 'M', added: 0, removed: 0 }] }],
        ['a listed path of 132 bytes in 66 UTF-16 units', { ...SUMMARY, listed: [{ path: '😀'.repeat(33), status: 'M', added: 0, removed: 0 }] }],
        ['a listed path that is empty', { ...SUMMARY, listed: [{ path: '', status: 'M', added: 0, removed: 0 }] }],
        ['an unknown file status', { ...SUMMARY, listed: [{ path: 'a', status: 'R', added: 0, removed: 0 }] }],
        ['a binary flag that is false', { ...SUMMARY, listed: [{ path: 'a', status: 'M', added: 0, removed: 0, binary: false }] }],
        ['a cut that is not two booleans', { ...SUMMARY, cut: { diff: 'no', screen: true } }],
        ['no cut', { ...SUMMARY, cut: undefined }],
    ])('is dropped for %s, and the question still opens', async (_name, context) => {
        const opened = await open(context);

        expect(opened.context).toBeUndefined();
        expect(opened).toMatchObject({ title: 'T', body: 'B', ask: { id: 'q', device: 'dev_laptop' } });
    });

    it('takes the limits themselves: 20 listed files, a path of exactly 128 bytes, a multibyte path', async () => {
        const at = (path: string) => ({ path, status: 'M' as const, added: 0, removed: 0 });
        const listed = [at('x'.repeat(128)), at('한'.repeat(42)), ...Array.from({ length: 18 }, (_, i) => at(`f${i}`))];
        expect(listed).toHaveLength(20);

        expect((await open({ ...SUMMARY, listed })).context).toEqual({ ...SUMMARY, listed });
    });

    it('keeps exactly the keys it knows: a key added later does not come through', async () => {
        const opened = await open({ ...SUMMARY, future: 'x', listed: [{ ...SUMMARY.listed[0], hunk: 'y' }] });

        expect(opened.context).toEqual({ ...SUMMARY, listed: [SUMMARY.listed[0]] });
    });
});

describe('malformed relay-supplied slot and envelope', () => {
    it('rejects a slot that is not { encryptedKey, keyIv } with the fixed message', async () => {
        const file = readVectors();
        const vector = file.vectors.find((v) => v.name === 'question')!;
        const recipient = await asDevice(file.keys.recipient);

        for (const slot of ['{}', '{"encryptedKey":"e","keyIv":123}', '[]', '"str"']) {
            await expect(recipient.decryptPushBodyForDevice(vector.body, slot, vector.senderPublicKey)).rejects.toThrow(
                'deviceKeyMap entry is not { encryptedKey, keyIv }',
            );
        }
    });

    it('rejects a body that is not a { ciphertext, iv } envelope before any key use', async () => {
        const file = readVectors();
        const vector = file.vectors.find((v) => v.name === 'question')!;
        const recipient = await asDevice(file.keys.recipient);

        for (const body of ['{}', '{"ciphertext":123,"iv":"e"}', '"str"']) {
            await expect(recipient.decryptPushBodyForDevice(body, vector.entry, vector.senderPublicKey)).rejects.toThrow(
                'push body is not a { ciphertext, iv } envelope',
            );
        }
    });
});
