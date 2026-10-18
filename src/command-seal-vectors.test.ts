import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushBodyInput } from './crypto.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The cli/mcp-server twin pin: both repos keep byte-identical envelopes built from
// the same fixed keys, so a seal either side makes opens on the other. The vector
// file is copied from hwipit/cli src/crypto-labels.vectors.json at cli commit
// 8c9fd06 (hwipit/cli#114: the sealed `keys` vector on top of the path-limit vectors and
// hwipit/cli#100's `question-with-context`; cli regenerates it with
// WRITE_LABEL_VECTORS=1 npx vitest run src/crypto-labels.test.ts; the iOS app
// opens the same file). crypto-labels.test.ts pins the bytes; here we prove this
// repo's real sealer and opener agree with the file.

const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };
const VECTOR_URL = new URL('./crypto-labels.vectors.json', import.meta.url);

interface KeyPair { publicKey: string; privateKey: string }
interface Vector {
    name: string;
    content: PushBodyInput;
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

const readVectors = (): VectorFile => JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as VectorFile;
const commandVector = (): { file: VectorFile; vector: Vector } => {
    const file = readVectors();
    const vector = file.vectors.find((v) => v.name === 'command');
    if (!vector) throw new Error('no command vector');
    return { file, vector };
};

let TMP: string;
const originalHome = process.env.HOME;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'mcp-seal-vectors-'));
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
});

/** A fresh module graph whose device key is the given pair, as if this host were that device. */
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

describe('cli vector file vs this repo', () => {
    it('still holds the cli bytes this copy was taken from', () => {
        expect(createHash('sha256').update(readFileSync(VECTOR_URL)).digest('hex'))
            .toBe('329d81c4c8c3b947b9baa0644086d15c6d5380d49812edd65511a7f2530d718c');
    });

    it('opens the cli-sealed command envelope for its target device', async () => {
        const { vector } = commandVector();
        const device = await asDevice(readVectors().keys.recipient);

        const opened = await device.decryptPushBodyForDevice(vector.body, vector.entry, vector.senderPublicKey);

        expect(opened.body).toBe(vector.content.body);
        expect(opened.cmd).toEqual(vector.content.cmd);
    });

    it('seals a command for the vector keys that the vector recipient opens', async () => {
        const { file, vector } = commandVector();
        const device = await asDevice(file.keys.recipient);
        const content: PushBodyInput = JSON.parse(JSON.stringify(vector.content));

        const sealed = await device.encryptPushBodyForDevices(content, [
            { deviceId: 'dev_target', publicKey: file.keys.recipient.publicKey },
        ]);

        expect(sealed.deviceKeyMap['dev_target']).toBeDefined();
        const opened = await device.decryptPushBodyForDevice(
            sealed.body,
            sealed.deviceKeyMap['dev_target'],
            sealed.senderPublicKey,
        );
        expect(opened.body).toBe(content.body);
        expect(opened.cmd).toEqual(content.cmd);
    });
});
