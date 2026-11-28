import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Guards a mutation run found unpinned in crypto.ts (t96 note #2 #3 #4 #8): the key-file race, the
// wire IV length, the sealed-label readers' rejections, and init/readiness state. Each test fails
// when the line it names is broken. HOME points at a temp dir, so ~/.hwip is never the real one.

const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };
const VECTOR_URL = new URL('./crypto-labels.vectors.json', import.meta.url);

interface KeyPair { publicKey: string; privateKey: string }
interface VectorFile { keys: { sender: KeyPair; recipient: KeyPair }; messageKey: string; iv: string; keyIv: string }

const originalHome = process.env.HOME;
const originalDisable = process.env.HWIP_DISABLE_ENCRYPTION;
let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'mcp-crypto-guards-'));
    delete process.env.HWIP_DISABLE_ENCRYPTION;
    process.env.HOME = TMP;
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalDisable === undefined) delete process.env.HWIP_DISABLE_ENCRYPTION;
    else process.env.HWIP_DISABLE_ENCRYPTION = originalDisable;
    vi.doUnmock('node:fs');
    vi.restoreAllMocks();
});

const toB64 = (buf: ArrayBuffer): string => Buffer.from(new Uint8Array(buf)).toString('base64');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');
const keysPath = (): string => join(TMP, '.hwip', 'device-keys.json');

const makeKeyPair = async (): Promise<KeyPair> => {
    const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey', 'deriveBits']);
    const [pub, priv] = await Promise.all([crypto.subtle.exportKey('spki', kp.publicKey), crypto.subtle.exportKey('pkcs8', kp.privateKey)]);
    return { publicKey: toB64(pub), privateKey: toB64(priv) };
};

const writeKeys = (contents: unknown, mode = 0o600): void => {
    mkdirSync(join(TMP, '.hwip'), { recursive: true });
    writeFileSync(keysPath(), JSON.stringify(contents), { mode });
};

// ── #2: a process that loses the key-file race adopts the winner's pair ──

describe('initCrypto when another process creates the key file first', () => {
    /** Make `linkSync` fail the way it does when the name exists: after the winner's file is in place. */
    const loseRaceTo = async (winner: unknown, code = 'EEXIST') => {
        vi.doMock('node:fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('node:fs')>();
            return {
                ...actual,
                linkSync: () => {
                    if (winner !== undefined) writeKeys(winner);
                    throw Object.assign(new Error(code), { code });
                },
            };
        });
        return import('./crypto.js');
    };

    it('uses the pair on disk, not its own', async () => {
        const winner = await makeKeyPair();
        const mod = await loseRaceTo(winner);

        const pub = await mod.initCrypto('ak_test');

        expect(pub).toBe(winner.publicKey);
        expect(mod.getPublicKey()).toBe(winner.publicKey);
        const exported = await crypto.subtle.exportKey('spki', mod.getKeyPair()!.publicKey);
        expect(toB64(exported)).toBe(winner.publicKey);
        expect(JSON.parse(readFileSync(keysPath(), 'utf8'))).toEqual(winner);
    });

    it('throws any link error that is not EEXIST', async () => {
        const mod = await loseRaceTo(undefined, 'EACCES');

        await expect(mod.initCrypto('ak_test')).rejects.toThrow('EACCES');
        expect(mod.getKeyPair()).toBeNull();
    });

    it('throws when the file that won holds no keypair', async () => {
        const mod = await loseRaceTo({ publicKey: 'only-half' });

        await expect(mod.initCrypto('ak_test')).rejects.toThrow(/exists but holds no keypair/);
    });
});

// ── #3: AES-GCM IV is 12 bytes and fresh every time (the phones assume it) ──

describe('sealing uses a 12-byte random IV', () => {
    const setup = async () => {
        const mod = await import('./crypto.js');
        await mod.initCrypto('ak_test');
        const device = await makeKeyPair();
        return { mod, recipients: [{ deviceId: 'dev_phone', publicKey: device.publicKey }] };
    };
    const keyIv = (entry: string): Buffer => unb64((JSON.parse(entry) as { keyIv: string }).keyIv);

    it('a push body: body IV and key-wrapping IV are 12 bytes, both new each call', async () => {
        const { mod, recipients } = await setup();

        const a = await mod.encryptPushBodyForDevices({ body: 'x' }, recipients);
        const b = await mod.encryptPushBodyForDevices({ body: 'x' }, recipients);

        const ivA = unb64((JSON.parse(a.body) as { iv: string }).iv);
        const ivB = unb64((JSON.parse(b.body) as { iv: string }).iv);
        expect(ivA).toHaveLength(12);
        expect(ivB).toHaveLength(12);
        expect(ivA.equals(ivB)).toBe(false);
        expect(keyIv(a.deviceKeyMap.dev_phone)).toHaveLength(12);
        expect(keyIv(a.deviceKeyMap.dev_phone).equals(keyIv(b.deviceKeyMap.dev_phone))).toBe(false);
    });

    it('a whole file: file IV and key-wrapping IV are 12 bytes, both new each call', async () => {
        const { mod, recipients } = await setup();

        const a = await mod.encryptFileForDevices('same', recipients);
        const b = await mod.encryptFileForDevices('same', recipients);

        expect(unb64(a.iv)).toHaveLength(12);
        expect(unb64(a.iv).equals(unb64(b.iv))).toBe(false);
        expect(keyIv(a.deviceKeyMap.dev_phone)).toHaveLength(12);
        expect(keyIv(a.deviceKeyMap.dev_phone).equals(keyIv(b.deviceKeyMap.dev_phone))).toBe(false);
    });

    it('a chunked file: the key-wrapping IV is 12 bytes and new each call', async () => {
        const { mod, recipients } = await setup();

        const a = await mod.encryptFileInChunksForDevices(Buffer.from('chunked'), recipients);
        const b = await mod.encryptFileInChunksForDevices(Buffer.from('chunked'), recipients);

        expect(keyIv(a.deviceKeyMap.dev_phone)).toHaveLength(12);
        expect(keyIv(a.deviceKeyMap.dev_phone).equals(keyIv(b.deviceKeyMap.dev_phone))).toBe(false);
    });

    it('derives the shared AES key as non-extractable', async () => {
        const derive = vi.spyOn(crypto.subtle, 'deriveKey');
        const { mod, recipients } = await setup();

        await mod.encryptPushBodyForDevices({ body: 'x' }, recipients);

        expect(derive).toHaveBeenCalled();
        for (const call of derive.mock.calls) expect(call[3]).toBe(false);
    });
});

// ── #4: the sealed-label readers drop a label that is missing a field or has one of the wrong type ──

describe('sealed label readers', () => {
    const open = async (content: unknown) => {
        const file = JSON.parse(readFileSync(VECTOR_URL, 'utf8')) as VectorFile; // own fixture file
        const { sender, recipient } = file.keys;
        const priv = await crypto.subtle.importKey('pkcs8', unb64(sender.privateKey), ECDH, false, ['deriveKey']);
        const pub = await crypto.subtle.importKey('spki', unb64(recipient.publicKey), ECDH, false, []);
        const shared = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
        const messageKey = await crypto.subtle.importKey('raw', unb64(file.messageKey), { name: 'AES-GCM' }, true, ['encrypt']);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, messageKey, new TextEncoder().encode(JSON.stringify(content)));
        const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unb64(file.keyIv) }, shared, unb64(file.messageKey));
        const body = JSON.stringify({ ciphertext: toB64(ciphertext), iv: file.iv });
        const entry = JSON.stringify({ encryptedKey: toB64(wrapped), keyIv: file.keyIv });

        writeKeys(recipient);
        vi.resetModules();
        const mod = await import('./crypto.js');
        await mod.initCrypto();
        return mod.decryptPushBodyForDevice(body, entry, sender.publicKey);
    };

    type Field = 'files' | 'keys' | 'cmd' | 'ask' | 'answer' | 'context';
    /** Every case: a valid label is kept, and each variant of it comes back `undefined`. */
    const readers: { field: Field; valid: unknown; bad: [string, unknown][] }[] = [
        {
            field: 'files',
            valid: [{ iv: 'a', name: 'n', type: 't', size: 3 }, { iv: 'b', name: 'm', type: 'u', size: 0, chunk: 1024 }],
            bad: [
                ['not an array', { iv: 'a', name: 'n', type: 't', size: 3 }],
                ['an item that is null', [null]],
                ['an item that is a string', ['x']],
                ['one good and one bad item', [{ iv: 'a', name: 'n', type: 't', size: 3 }, { iv: 'a', name: 'n', type: 't' }]],
                ...(['iv', 'name', 'type', 'size'] as const).flatMap((k): [string, unknown][] => {
                    const base: Record<string, unknown> = { iv: 'a', name: 'n', type: 't', size: 3 };
                    const { [k]: _gone, ...without } = base;
                    return [[`item without ${k}`, [without]], [`item with ${k} of the wrong type`, [{ ...base, [k]: k === 'size' ? '3' : 3 }]]];
                }),
            ],
        },
        {
            field: 'keys',
            valid: ['enter', 'tab'],
            bad: [['empty list', []], ['not an array', 'enter'], ['a number inside', ['enter', 5]], ['an object inside', [{}]]],
        },
        {
            field: 'cmd',
            valid: { n: 1, session: 's', device: 'd', from: 'dev_x' },
            bad: [
                ['a string', 'cmd'],
                ['null', null],
                ['no n', { session: 's', device: 'd' }],
                ['no session', { n: 1, device: 'd' }],
                ['no device', { n: 1, session: 's' }],
                ['n as a string', { n: '1', session: 's', device: 'd' }],
                ['session as a number', { n: 1, session: 2, device: 'd' }],
                ['device as a number', { n: 1, session: 's', device: 2 }],
                ['from as a number', { n: 1, session: 's', device: 'd', from: 2 }],
            ],
        },
        {
            field: 'ask',
            valid: { id: 'x'.repeat(128), device: 'dev_1', placeholder: 'p', actions: [{ id: 'a', label: 'A', style: 'primary', prompt: 'go' }, { id: 'x'.repeat(64), label: 'y'.repeat(100) }] },
            bad: [
                ['a string', 'ask'],
                ['null', null],
                ['no id', { device: 'd' }],
                ['no device', { id: 'q' }],
                ['id as a number', { id: 1, device: 'd' }],
                ['device as a number', { id: 'q', device: 1 }],
                ['id of 129 characters', { id: 'x'.repeat(129), device: 'd' }],
                ['actions not an array', { id: 'q', device: 'd', actions: 'a' }],
                ['an action that is null', { id: 'q', device: 'd', actions: [null] }],
                ['an action without id', { id: 'q', device: 'd', actions: [{ label: 'A' }] }],
                ['an action without label', { id: 'q', device: 'd', actions: [{ id: 'a' }] }],
                ['an action id as a number', { id: 'q', device: 'd', actions: [{ id: 1, label: 'A' }] }],
                ['an action label as a number', { id: 'q', device: 'd', actions: [{ id: 'a', label: 1 }] }],
                ['an action id of 65 characters', { id: 'q', device: 'd', actions: [{ id: 'x'.repeat(65), label: 'A' }] }],
                ['an action label of 101 characters', { id: 'q', device: 'd', actions: [{ id: 'a', label: 'y'.repeat(101) }] }],
                ['an action style as a number', { id: 'q', device: 'd', actions: [{ id: 'a', label: 'A', style: 1 }] }],
                ['an action prompt as a number', { id: 'q', device: 'd', actions: [{ id: 'a', label: 'A', prompt: 1 }] }],
                ['an empty action prompt', { id: 'q', device: 'd', actions: [{ id: 'a', label: 'A', prompt: '' }] }],
                ['a placeholder as a number', { id: 'q', device: 'd', placeholder: 1 }],
            ],
        },
        {
            field: 'answer',
            valid: { ask: 'x'.repeat(128), actionId: 'a', exit: true },
            bad: [
                ['a string', 'answer'],
                ['null', null],
                ['no ask', { actionId: 'a' }],
                ['ask as a number', { ask: 1 }],
                ['an empty ask', { ask: '' }],
                ['ask of 129 characters', { ask: 'x'.repeat(129) }],
                ['actionId as a number', { ask: 'q', actionId: 1 }],
                ['exit false', { ask: 'q', exit: false }],
                ['exit as a string', { ask: 'q', exit: 'true' }],
            ],
        },
        {
            field: 'context',
            valid: { diff: 'ok', files: 1, added: 2, removed: 3, listed: [{ path: 'a.ts', status: 'M', added: 2, removed: 3 }, { path: 'b.png', status: '?', added: 0, removed: 0, binary: true }], moreFiles: 0, screenLines: 4, masked: 0, cut: { diff: false, screen: true } },
            bad: [
                ['a string', 'context'],
                ['null', null],
                ['diff of another value', { diff: 'maybe', files: 0, added: 0, removed: 0, listed: [], moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: false, screen: false } }],
                ...(['files', 'added', 'removed', 'moreFiles', 'screenLines', 'masked'] as const).flatMap((k): [string, unknown][] => {
                    const base: Record<string, unknown> = { diff: 'no_repo', files: 0, added: 0, removed: 0, listed: [], moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: false, screen: false } };
                    return [[`${k} negative`, { ...base, [k]: -1 }], [`${k} fractional`, { ...base, [k]: 1.5 }], [`${k} a string`, { ...base, [k]: '1' }]];
                }),
                ['listed not an array', { diff: 'ok', files: 0, added: 0, removed: 0, listed: 'x', moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: false, screen: false } }],
                ['listed item with an odd status', { diff: 'ok', files: 1, added: 0, removed: 0, listed: [{ path: 'a', status: 'X', added: 0, removed: 0 }], moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: false, screen: false } }],
                ['listed item with an empty path', { diff: 'ok', files: 1, added: 0, removed: 0, listed: [{ path: '', status: 'M', added: 0, removed: 0 }], moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: false, screen: false } }],
                ['listed item with binary false', { diff: 'ok', files: 1, added: 0, removed: 0, listed: [{ path: 'a', status: 'M', added: 0, removed: 0, binary: false }], moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: false, screen: false } }],
                ['no cut', { diff: 'ok', files: 0, added: 0, removed: 0, listed: [], moreFiles: 0, screenLines: 0, masked: 0 }],
                ['cut.diff as a string', { diff: 'ok', files: 0, added: 0, removed: 0, listed: [], moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: 'no', screen: false } }],
                ['cut.screen missing', { diff: 'ok', files: 0, added: 0, removed: 0, listed: [], moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: false } }],
            ],
        },
    ];

    for (const { field, valid, bad } of readers) {
        describe(field, () => {
            it('keeps a well-formed label', async () => {
                expect((await open({ [field]: valid }))[field]).toEqual(valid);
            });
            it.each(bad)('drops it for %s', async (_name, value) => {
                expect((await open({ [field]: value }))[field]).toBeUndefined();
            });
        });
    }

    it('reads a file chunk size only when it is a number', async () => {
        const opened = await open({ files: [{ iv: 'a', name: 'n', type: 't', size: 3, chunk: '1024' }] });
        expect(opened.files).toEqual([{ iv: 'a', name: 'n', type: 't', size: 3 }]);
    });

    it('keeps a label at each size limit and drops one past it', async () => {
        const actions = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, label: `A${i}` }));
        expect((await open({ ask: { id: 'q', device: 'd', actions: actions(10) } })).ask?.actions).toHaveLength(10);
        expect((await open({ ask: { id: 'q', device: 'd', actions: actions(11) } })).ask).toBeUndefined();

        const withPrompt = (n: number) => ({ ask: { id: 'q', device: 'd', actions: [{ id: 'a', label: 'A', prompt: 'p'.repeat(n) }] } });
        expect((await open(withPrompt(500))).ask).toBeDefined();
        expect((await open(withPrompt(501))).ask).toBeUndefined();

        const base = { diff: 'ok', files: 0, added: 0, removed: 0, moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: false, screen: false } };
        const file = (path: string) => ({ path, status: 'M', added: 0, removed: 0 });
        const files = (n: number) => Array.from({ length: n }, (_, i) => file(`f${i}`));
        expect((await open({ context: { ...base, listed: files(20) } })).context?.listed).toHaveLength(20);
        expect((await open({ context: { ...base, listed: files(21) } })).context).toBeUndefined();
        // The path limit counts bytes, not characters: 64 two-byte characters fit, 65 do not.
        expect((await open({ context: { ...base, listed: [file('é'.repeat(64))] } })).context?.listed).toHaveLength(1);
        expect((await open({ context: { ...base, listed: [file('é'.repeat(65))] } })).context).toBeUndefined();
    });

    it('drops a context whose listed file is null or has only one valid count', async () => {
        const base = { diff: 'ok', files: 1, added: 0, removed: 0, moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: false, screen: false } };
        const listed = (item: unknown) => ({ context: { ...base, listed: [item] } });
        expect((await open(listed(null))).context).toBeUndefined();
        expect((await open(listed({ path: 'a', status: 'M', added: 'x', removed: 0 }))).context).toBeUndefined();
        expect((await open(listed({ path: 'a', status: 'M', added: 0, removed: 'x' }))).context).toBeUndefined();
    });

    it('accepts each context diff state and file status', async () => {
        const base = { files: 0, added: 0, removed: 0, listed: [], moreFiles: 0, screenLines: 0, masked: 0, cut: { diff: false, screen: false } };
        for (const diff of ['ok', 'no_repo', 'failed']) expect((await open({ context: { ...base, diff } })).context?.diff).toBe(diff);
        for (const status of ['M', 'A', 'D', '?']) {
            const listed = [{ path: 'f', status, added: 0, removed: 0 }];
            expect((await open({ context: { ...base, diff: 'ok', files: 1, listed } })).context?.listed).toEqual(listed);
        }
    });
});

// ── #8: start-up and readiness state ──

describe('initCrypto and cryptoReady state', () => {
    it('refuses a key file that holds only one half of the pair', async () => {
        const full = await makeKeyPair();
        writeKeys({ publicKey: full.publicKey });
        const mod = await import('./crypto.js');

        await expect(mod.initCrypto('ak_test')).rejects.toThrow(/exists but holds no keypair/);
        expect(mod.getKeyPair()).toBeNull();
    });

    it('treats a half pair as no keys when there is no API key', async () => {
        const full = await makeKeyPair();
        writeKeys({ privateKey: full.privateKey });
        const mod = await import('./crypto.js');

        expect(await mod.initCrypto()).toBe('');
        expect(mod.getKeyPair()).toBeNull();
    });

    it('joins concurrent starts into one', async () => {
        const mod = await import('./crypto.js');

        const first = mod.initCrypto('ak_test');
        const second = mod.initCrypto('ak_test');

        expect(second).toBe(first);
        expect(await second).toBe(await first);
    });

    it('lets the next send retry a start that failed, once the key file is fixed', async () => {
        const pair = await makeKeyPair();
        writeKeys(pair, 0o644);
        const mod = await import('./crypto.js');
        await expect(mod.initCrypto('ak_test')).rejects.toThrow(/refusing to use it/);
        expect(mod.getKeyPair()).toBeNull();

        chmodSync(keysPath(), 0o600);
        await mod.cryptoReady();

        expect(mod.getPublicKey()).toBe(pair.publicKey);
        expect(mod.getKeyPair()).not.toBeNull();
    });

    it('does not start again for a start that found no keys and needed none', async () => {
        const mod = await import('./crypto.js');
        expect(await mod.initCrypto()).toBe('');
        writeKeys(await makeKeyPair());

        await mod.cryptoReady();

        expect(mod.getKeyPair()).toBeNull();
    });

    it('says in the status line whether it has keys', async () => {
        const mod = await import('./crypto.js');
        expect(mod.cryptoStatusLine()).toContain('no device keys');

        await mod.initCrypto('ak_test');
        expect(mod.cryptoStatusLine()).toContain('E2E encryption on');
        expect(mod.cryptoStatusLine()).not.toContain('no device keys');
    });

    it.each([
        ['encryptPushBodyForDevices', (m: typeof import('./crypto.js')) => m.encryptPushBodyForDevices({ body: 'x' }, [])],
        ['encryptFileForDevices', (m: typeof import('./crypto.js')) => m.encryptFileForDevices('x', [])],
        ['encryptFileInChunksForDevices', (m: typeof import('./crypto.js')) => m.encryptFileInChunksForDevices(Buffer.from('x'), [])],
        ['decryptFileForDevice', (m: typeof import('./crypto.js')) => m.decryptFileForDevice(Buffer.from('x'), '', '{}', '')],
        ['decryptPushBodyForDevice', (m: typeof import('./crypto.js')) => m.decryptPushBodyForDevice('{"ciphertext":"a","iv":"b"}', '{}', '')],
    ])('%s says "Crypto not initialized" before there are keys', async (_name, call) => {
        const mod = await import('./crypto.js');

        await expect(call(mod)).rejects.toThrow('Crypto not initialized');
    });
});
