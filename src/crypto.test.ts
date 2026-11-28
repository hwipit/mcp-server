import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// crypto.ts caches a keypair at module scope. We use vi.resetModules() in
// every test to start from a clean slate and point HOME at a temp dir so
// the on-disk keystore never touches the developer's real ~/.hwip.
//
// IMPORTANT: do not reassign process.env — that detaches the JS object
// from the native getenv() that os.homedir() reads. Set individual keys.

const CRYPTO_ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'HWIP_DISABLE_ENCRYPTION'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of CRYPTO_ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'mcp-crypto-test-'));
    for (const key of CRYPTO_ENV_KEYS) delete process.env[key];
    process.env.HOME = TMP;
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('crypto must not call the server'); }));
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of CRYPTO_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ── Helpers ──

const toB64 = (buf: ArrayBuffer): string => Buffer.from(new Uint8Array(buf)).toString('base64');
const fromB64 = (b64: string): Buffer => Buffer.from(b64, 'base64');
const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };

/** Generate a base64-encoded ECDH P-256 keypair, standing in for a device. */
const makeKeyPair = async (): Promise<{ publicKey: string; privateKey: string }> => {
    const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey', 'deriveBits']);
    const [pubSpki, privPkcs8] = await Promise.all([
        crypto.subtle.exportKey('spki', kp.publicKey),
        crypto.subtle.exportKey('pkcs8', kp.privateKey),
    ]);
    return { publicKey: toB64(pubSpki), privateKey: toB64(privPkcs8) };
};

const configDir = (root = TMP): string => join(root, '.config', 'hwip');
/** The Machine Device keypair, shared with `hwip listener`. */
const deviceKeysPath = (root = TMP): string => join(root, '.hwip', 'device-keys.json');
const legacyKeysPath = (root = TMP): string => join(configDir(root), 'keys.json');

const writeFileAt = (path: string, contents: unknown): string => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(contents), { mode: 0o600 });
    return path;
};

/**
 * Unwrap the way a recipient device does: derive ECDH(my private, sender
 * public), unwrap the per-message key, then decrypt.
 */
const decryptAsDevice = async (
    devicePrivateKey: string,
    senderPublicKey: string,
    wrappedEntry: string,
    ciphertext: BufferSource,
    iv: string,
): Promise<Buffer> => {
    const privateKey = await crypto.subtle.importKey('pkcs8', fromB64(devicePrivateKey), ECDH, false, ['deriveKey']);
    const publicKey = await crypto.subtle.importKey('spki', fromB64(senderPublicKey), ECDH, false, []);
    const sharedKey = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: publicKey },
        privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
    );

    const { encryptedKey, keyIv } = JSON.parse(wrappedEntry) as { encryptedKey: string; keyIv: string };
    const rawKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(keyIv) }, sharedKey, fromB64(encryptedKey));
    const messageKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);

    return Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, messageKey, ciphertext));
};

/** Bring crypto up with encryption on, and return one recipient device. */
const initEnabled = async () => {
    const mod = await import('./crypto.js');
    await mod.initCrypto('ak_test');
    const device = await makeKeyPair();
    return { ...mod, device, recipients: [{ deviceId: 'dev_phone', publicKey: device.publicKey }] };
};

// ── initCrypto ──

describe('initCrypto', () => {
    it('generates and persists its own keypair when the account has opted in', async () => {
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');

        const pub = await initCrypto('ak_test');

        expect(pub).toBeTruthy();
        expect(getPublicKey()).toBe(pub);
        expect(getKeyPair()).not.toBeNull();
        expect(existsSync(deviceKeysPath())).toBe(true);
        // The private key is created here and stays here — the server is asked nothing.
        expect(fetch).not.toHaveBeenCalled();
    });

    it('reuses the keypair on disk instead of rotating on every start', async () => {
        const first = await import('./crypto.js');
        const pubA = await first.initCrypto('ak_test');

        vi.resetModules();
        const second = await import('./crypto.js');
        const pubB = await second.initCrypto('ak_test');

        // A rotating key would strand every push already wrapped for the old one.
        expect(pubB).toBe(pubA);
    });

    it('creates and stores a keypair on first start', async () => {
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');

        const pub = await initCrypto('ak_test');

        expect(pub).not.toBe('');
        expect(getPublicKey()).toBe(pub);
        expect(getKeyPair()).not.toBeNull();
        expect(existsSync(deviceKeysPath())).toBe(true);
    });

    it('says at start that every push is sealed', async () => {
        const { initCrypto, cryptoStatusLine } = await import('./crypto.js');
        await initCrypto('ak_test');
        expect(cryptoStatusLine()).toMatch(/E2E encryption on .* every push, question and command is sealed/);
    });

    // M5: a key file that would not load at start-up is not the end of this process's sends.
    it('loads the keys on a later send once the file that failed at start-up is fixed', async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(deviceKeysPath(), '{ broken', { mode: 0o600 });
        const { initCrypto, cryptoReady, getPublicKey } = await import('./crypto.js');
        await expect(initCrypto('ak_test')).rejects.toThrow();

        await cryptoReady();
        expect(getPublicKey()).toBeNull();

        const own = await makeKeyPair();
        writeFileAt(deviceKeysPath(), own);
        await cryptoReady();
        expect(getPublicKey()).toBe(own.publicKey);
    });

    it('lets a send wait for the start that is still on its way', async () => {
        const { initCrypto, cryptoReady, getKeyPair } = await import('./crypto.js');
        void initCrypto('ak_test');
        const ready = cryptoReady();
        expect(getKeyPair()).toBeNull();
        await ready;
        expect(getKeyPair()).not.toBeNull();
    });

    it('deletes the escrowed account keypair an old build may have left behind', async () => {
        // keys.json held a private key the server used to hand out. Nothing
        // reads it any more, so it is dead key material sitting on disk.
        const stale = await makeKeyPair();
        writeFileAt(legacyKeysPath(), stale);

        const { initCrypto } = await import('./crypto.js');
        await initCrypto('ak_test');

        expect(existsSync(legacyKeysPath())).toBe(false);
    });

    // F16: there is no host switch — the old opt-out variable turns nothing off.
    it('ignores HWIP_DISABLE_ENCRYPTION', async () => {
        process.env.HWIP_DISABLE_ENCRYPTION = '1';
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');

        const pub = await initCrypto('ak_test');

        expect(pub).not.toBe('');
        expect(getPublicKey()).toBe(pub);
        expect(getKeyPair()).not.toBeNull();
    });

    it('local-only mode (no apiKey) returns empty when no stored keys exist', async () => {
        const { initCrypto, getPublicKey } = await import('./crypto.js');
        const pub = await initCrypto();
        expect(pub).toBe('');
        expect(getPublicKey()).toBeNull();
        // It must NOT generate one as a fallback — nothing sends without an apiKey.
        expect(existsSync(deviceKeysPath())).toBe(false);
    });

    it('local-only mode imports a pre-provisioned device-keys.json', async () => {
        const own = await makeKeyPair();
        writeFileAt(deviceKeysPath(), own);
        const { initCrypto, getPublicKey } = await import('./crypto.js');
        const pub = await initCrypto();
        expect(pub).toBe(own.publicKey);
        expect(getPublicKey()).toBe(own.publicKey);
    });

    it('uses the listener\'s machine keypair, and deletes the one this server used to keep in ~/.config/hwip', async () => {
        const machine = await makeKeyPair();
        writeFileAt(deviceKeysPath(), machine);
        const retired = writeFileAt(join(configDir(), 'device-keys.json'), await makeKeyPair());   // left by an older build
        const { initCrypto } = await import('./crypto.js');
        expect(await initCrypto('ak_test')).toBe(machine.publicKey);
        expect(existsSync(retired)).toBe(false);
    });

    it('two initialisers racing to create the keypair converge on the one linked into place', async () => {
        const listener = await import('./crypto.js');
        vi.resetModules();
        const mcp = await import('./crypto.js');   // a second module instance stands in for the listener
        const [a, b] = await Promise.all([
            listener.initCrypto('ak_test'),
            mcp.initCrypto('ak_test'),
        ]);
        expect(a).toBe(b);
        expect((JSON.parse(readFileSync(deviceKeysPath(), 'utf-8')) as { publicKey: string }).publicKey).toBe(a);
    });

    it('never overwrites a keypair file it cannot read — the listener shares it', async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(deviceKeysPath(), '{"publicKey":', { mode: 0o600 });
        const { initCrypto, getKeyPair } = await import('./crypto.js');
        await expect(initCrypto('ak_test')).rejects.toThrow(/holds no keypair/);
        expect(readFileSync(deviceKeysPath(), 'utf-8')).toBe('{"publicKey":');
        expect(getKeyPair()).toBeNull();
    });

    it('judges a private key by owner and mode: any group or other access is refused', async () => {
        const { deviceKeysModeProblem } = await import('./crypto.js');

        expect(deviceKeysModeProblem({ uid: 0, mode: 0o100600 }, 501, '/h/.hwip/device-keys.json')).toEqual({
            refuse: true,
            why: '/h/.hwip/device-keys.json belongs to another user (uid 0), refusing to use it',
        });
        for (const mode of [0o620, 0o640, 0o644, 0o666, 0o602, 0o604]) {
            expect(deviceKeysModeProblem({ uid: 501, mode: 0o100000 | mode }, 501)).toMatchObject({
                refuse: true,
                why: expect.stringMatching(/refusing to use it — run `chmod 600 /),
            });
        }
        expect(deviceKeysModeProblem({ uid: 501, mode: 0o100600 }, 501)).toBeNull();
        expect(deviceKeysModeProblem({ uid: 501, mode: 0o100400 }, 501)).toBeNull();
        expect(deviceKeysModeProblem({ uid: 501, mode: 0o100600 }, 0)).toBeNull();
    });

    it('reads the key through one descriptor: open, fstat, read that descriptor', async () => {
        const { readPrivateFile } = await import('./file-mode.js');
        const calls: string[] = [];
        const io = {
            openSync: (() => { calls.push('open'); return 7; }) as never,
            fstatSync: ((fd: number) => { calls.push(`fstat ${fd}`); return { uid: 501, mode: 0o100600 }; }) as never,
            readFileSync: ((target: unknown) => { calls.push(`read ${String(target)}`); return '{}'; }) as never,
            closeSync: ((fd: number) => { calls.push(`close ${fd}`); }) as never,
        };
        const messages = { ownerRefusal: () => 'o', worldWritableRefusal: () => 'w', exposedRefusal: () => 'e', exposedWarning: () => 'x' };

        const text = readPrivateFile('/h/.hwip/device-keys.json', messages, () => undefined, io, { platform: 'linux', getuid: () => 501 });

        expect(text).toBe('{}');
        expect(calls).toEqual(['open', 'fstat 7', 'read 7', 'close 7']);
    });

    it('treats only a missing file as absent: any other open error refuses', async () => {
        const { readPrivateFile } = await import('./file-mode.js');
        const messages = { ownerRefusal: () => 'o', worldWritableRefusal: () => 'w', exposedRefusal: () => 'e', exposedWarning: () => 'x' };
        const failing = (code: string) => ({
            openSync: (() => { throw Object.assign(new Error(code), { code }); }) as never,
            fstatSync: (() => { throw new Error('unreachable'); }) as never,
            readFileSync: (() => { throw new Error('unreachable'); }) as never,
            closeSync: (() => undefined) as never,
        });
        const env = { platform: 'linux' as const, getuid: () => 501 };

        expect(readPrivateFile('/f', messages, () => undefined, failing('ENOENT'), env)).toBeNull();
        for (const code of ['EACCES', 'ELOOP', 'EIO']) {
            expect(() => readPrivateFile('/f', messages, () => undefined, failing(code), env)).toThrow(`cannot be checked (${code}), refusing to use it`);
        }
    });

    describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('device-keys.json on disk', () => {
        it.each([0o666, 0o620, 0o640, 0o644])('refuses a device-keys.json with mode %o', async (mode) => {
            const own = await makeKeyPair();
            writeFileAt(deviceKeysPath(), own);
            chmodSync(deviceKeysPath(), mode);
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            const { initCrypto, getPublicKey } = await import('./crypto.js');

            await expect(initCrypto('ak_test')).rejects.toThrow(/refusing to use it — run `chmod 600 /);
            expect(getPublicKey()).toBeNull();
            expect(error).toHaveBeenCalledWith(expect.stringContaining(`mode ${mode.toString(8)}`));
        });

        it('says it once however many times the key is loaded', async () => {
            const own = await makeKeyPair();
            writeFileAt(deviceKeysPath(), own);
            chmodSync(deviceKeysPath(), 0o644);
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            const { initCrypto } = await import('./crypto.js');
            await expect(initCrypto('ak_test')).rejects.toThrow();
            await expect(initCrypto('ak_test')).rejects.toThrow();

            expect(error.mock.calls.filter(([msg]) => String(msg).includes('mode 644'))).toHaveLength(1);
        });

        it('judges a symlinked device-keys.json by what it points at', async () => {
            const own = await makeKeyPair();
            const target = join(TMP, 'dotfiles-keys.json');
            writeFileAt(target, own);
            chmodSync(target, 0o666);
            mkdirSync(join(TMP, '.hwip'), { recursive: true });
            symlinkSync(target, deviceKeysPath());
            vi.spyOn(console, 'error').mockImplementation(() => undefined);

            const { initCrypto } = await import('./crypto.js');

            await expect(initCrypto('ak_test')).rejects.toThrow(/refusing to use it/);
        });

        it('accepts an owner-only device-keys.json without a word', async () => {
            const own = await makeKeyPair();
            writeFileAt(deviceKeysPath(), own);
            chmodSync(deviceKeysPath(), 0o600);
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            const { initCrypto } = await import('./crypto.js');

            await expect(initCrypto('ak_test')).resolves.toBe(own.publicKey);
            expect(error.mock.calls.some(([msg]) => /refusing|reached by other/.test(String(msg)))).toBe(false);
        });
    });

    it('writes the keypair with owner-only permissions', async () => {
        const { initCrypto } = await import('./crypto.js');
        await initCrypto('ak_test');

        const stored = JSON.parse(readFileSync(deviceKeysPath(), 'utf-8')) as { privateKey?: string };
        expect(stored.privateKey).toBeTruthy();
    });

    it('deduplicates concurrent initCrypto calls', async () => {
        const { initCrypto } = await import('./crypto.js');

        const [a, b] = await Promise.all([
            initCrypto('ak_test'),
            initCrypto('ak_test'),
        ]);

        expect(a).toBe(b);
    });
});

// ── selectRecipients ──

describe('selectRecipients', () => {
    it('keeps devices that registered a per-device public key', async () => {
        const a = await makeKeyPair();
        const b = await makeKeyPair();
        const { initCrypto, selectRecipients } = await import('./crypto.js');
        await initCrypto('ak_test');

        const picked = selectRecipients([
            { deviceId: 'dev_a', publicKey: a.publicKey },
            { deviceId: 'dev_b', publicKey: b.publicKey },
        ]);

        expect(picked.map((d) => d.deviceId)).toEqual(['dev_a', 'dev_b']);
    });

    it('drops devices with no public key at all', async () => {
        const a = await makeKeyPair();
        const { initCrypto, selectRecipients } = await import('./crypto.js');
        await initCrypto('ak_test');

        const picked = selectRecipients([
            { deviceId: 'dev_a', publicKey: a.publicKey },
            { deviceId: 'dev_old' },
        ]);

        expect(picked.map((d) => d.deviceId)).toEqual(['dev_a']);
    });

});

// ── encryptPushBodyForDevices ──

describe('encryptPushBodyForDevices', () => {
    it('produces an envelope every recipient device can open', async () => {
        const { initCrypto, encryptPushBodyForDevices } = await import('./crypto.js');
        await initCrypto('ak_test');

        const phone = await makeKeyPair();
        const laptop = await makeKeyPair();
        const enc = await encryptPushBodyForDevices(
            { title: 'hi', body: 'hello world', url: 'https://x.test' },
            [{ deviceId: 'dev_phone', publicKey: phone.publicKey }, { deviceId: 'dev_laptop', publicKey: laptop.publicKey }],
        );

        expect(enc.isEncrypted).toBe(true);
        expect(Object.keys(enc.deviceKeyMap)).toEqual(['dev_phone', 'dev_laptop']);
        const { ciphertext, iv } = JSON.parse(enc.body) as { ciphertext: string; iv: string };

        for (const [deviceId, kp] of [['dev_phone', phone], ['dev_laptop', laptop]] as const) {
            const plaintext = await decryptAsDevice(
                kp.privateKey, enc.senderPublicKey, enc.deviceKeyMap[deviceId], fromB64(ciphertext), iv,
            );
            expect(JSON.parse(plaintext.toString('utf-8'))).toEqual({
                title: 'hi', body: 'hello world', url: 'https://x.test',
            });
        }
    });

    it('gives a device outside the recipient list nothing to unwrap', async () => {
        const { encryptPushBodyForDevices, device, recipients } = await initEnabled();
        const stranger = await makeKeyPair();

        const enc = await encryptPushBodyForDevices({ body: 'private' }, recipients);
        const { ciphertext, iv } = JSON.parse(enc.body) as { ciphertext: string; iv: string };

        expect(enc.deviceKeyMap['dev_stranger']).toBeUndefined();
        // Even handed the phone's wrapped key, a different private key derives a
        // different shared secret and the unwrap fails.
        await expect(
            decryptAsDevice(stranger.privateKey, enc.senderPublicKey, enc.deviceKeyMap['dev_phone'], fromB64(ciphertext), iv),
        ).rejects.toThrow();
        expect(device.publicKey).toBeTruthy();
    });

    it('produces different ciphertext on repeated calls (random IV)', async () => {
        const { encryptPushBodyForDevices, recipients } = await initEnabled();

        const a = await encryptPushBodyForDevices({ body: 'same text' }, recipients);
        const b = await encryptPushBodyForDevices({ body: 'same text' }, recipients);
        expect(JSON.parse(a.body).ciphertext).not.toBe(JSON.parse(b.body).ciphertext);
    });

    it('throws rather than sending unencrypted when no recipient is usable', async () => {
        const { encryptPushBodyForDevices } = await initEnabled();
        await expect(
            encryptPushBodyForDevices({ body: 'x' }, [{ deviceId: 'dev_bad', publicKey: 'not-a-key' }]),
        ).rejects.toThrow(/No recipient device/);
    });

    it('throws when called before initCrypto', async () => {
        const { encryptPushBodyForDevices } = await import('./crypto.js');
        await expect(encryptPushBodyForDevices({ body: 'x' }, [])).rejects.toThrow(/Crypto not initialized/);
    });
});

// ── encryptFileInChunksForDevices ──

describe('encryptFileInChunksForDevices', () => {
    it('seals 1 MiB pieces a recipient opens with its unwrapped key and nonce = prefix ‖ index ‖ last', async () => {
        const { encryptFileInChunksForDevices, getPublicKey, device, recipients } = await initEnabled();
        const { createDecipheriv } = await import('node:crypto');
        const plain = Buffer.from(Array.from({ length: 1_048_576 + 10 }, (_, i) => (i * 7) & 0xff));

        const enc = await encryptFileInChunksForDevices(plain, recipients);

        expect(enc.chunk).toBe(1_048_576);
        const prefix = fromB64(enc.iv);
        expect(prefix.length).toBe(7);
        expect(enc.ciphertext.length).toBe(plain.length + 2 * 16);
        // The file key, unwrapped as the phone does.
        const privateKey = await crypto.subtle.importKey('pkcs8', fromB64(device.privateKey), ECDH, false, ['deriveKey']);
        const sender = await crypto.subtle.importKey('spki', fromB64(getPublicKey()!), ECDH, false, []);
        const shared = await crypto.subtle.deriveKey({ name: 'ECDH', public: sender }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        const { encryptedKey, keyIv } = JSON.parse(enc.deviceKeyMap['dev_phone']) as { encryptedKey: string; keyIv: string };
        const fileKey = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(keyIv) }, shared, fromB64(encryptedKey)));
        const pieces = [enc.ciphertext.subarray(0, 1_048_576 + 16), enc.ciphertext.subarray(1_048_576 + 16)];
        const opened = pieces.map((piece, index) => {
            const nonce = Buffer.concat([prefix, Buffer.from([0, 0, 0, index, index === pieces.length - 1 ? 1 : 0])]);
            const decipher = createDecipheriv('aes-256-gcm', fileKey, nonce);
            decipher.setAuthTag(piece.subarray(piece.length - 16));
            return Buffer.concat([decipher.update(piece.subarray(0, piece.length - 16)), decipher.final()]);
        });
        expect(Buffer.concat(opened).equals(plain)).toBe(true);
    });
});

// ── encryptFileForDevices ──

describe('encryptFileForDevices', () => {
    it('returns a ciphertext buffer, an iv, and one wrapped key per device', async () => {
        const { encryptFileForDevices, recipients } = await initEnabled();

        const enc = await encryptFileForDevices('file content here', recipients);
        expect(Buffer.isBuffer(enc.ciphertext)).toBe(true);
        expect(enc.ciphertext.length).toBeGreaterThan(0);
        expect(enc.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
        const keyEnv = JSON.parse(enc.deviceKeyMap['dev_phone']);
        expect(keyEnv).toHaveProperty('encryptedKey');
        expect(keyEnv).toHaveProperty('keyIv');
    });

    // Binary attachments used to be UTF-8 encoded on the way in, which silently
    // corrupted every non-ASCII byte. This asserts the whole round trip against
    // real crypto — the tool tests mock this module, so they cannot catch it.
    it('round-trips a binary Buffer byte for byte', async () => {
        const { encryptFileForDevices, getPublicKey, device, recipients } = await initEnabled();

        // A 1x1 PNG — every high byte in the signature is a corruption tripwire.
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
        );

        const enc = await encryptFileForDevices(png, recipients);
        const decrypted = await decryptAsDevice(
            device.privateKey, getPublicKey()!, enc.deviceKeyMap['dev_phone'], enc.ciphertext, enc.iv,
        );

        expect(decrypted.equals(png)).toBe(true);
    });

    it('still round-trips text unchanged', async () => {
        const { encryptFileForDevices, getPublicKey, device, recipients } = await initEnabled();

        const enc = await encryptFileForDevices('héllo — 안녕', recipients);
        const decrypted = await decryptAsDevice(
            device.privateKey, getPublicKey()!, enc.deviceKeyMap['dev_phone'], enc.ciphertext, enc.iv,
        );

        expect(decrypted.toString('utf-8')).toBe('héllo — 안녕');
    });

    it('encrypts the bytes once no matter how many devices there are', async () => {
        const { initCrypto, encryptFileForDevices } = await import('./crypto.js');
        await initCrypto('ak_test');

        const a = await makeKeyPair();
        const b = await makeKeyPair();
        const content = 'shared body';

        const enc = await encryptFileForDevices(content, [
            { deviceId: 'dev_a', publicKey: a.publicKey },
            { deviceId: 'dev_b', publicKey: b.publicKey },
        ]);

        // The S3 object must not grow with the device count — only the wrapped
        // keys repeat. GCM adds a 16-byte tag to the plaintext length.
        expect(enc.ciphertext.length).toBe(Buffer.byteLength(content) + 16);
        expect(Object.keys(enc.deviceKeyMap)).toHaveLength(2);
    });
});
