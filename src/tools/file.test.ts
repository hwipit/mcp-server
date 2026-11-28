import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';

// Mock crypto (see notify.test.ts for the rationale). Every test starts with keys.
// The trust file is this machine's (~/.hwip/trusted-devices.json): pinning is push-audience.test.ts's, kept out of it here.
vi.mock('../trust-pins.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../trust-pins.js')>()),
    TRUST_PATH: '/nonexistent/trusted-devices.json',
    observeDevices: vi.fn(() => ({ pinned: [], replaced: [], skipped: [], status: 'ok' })),
}));

vi.mock('../crypto.js', () => ({
    cryptoReady: vi.fn(async () => undefined),
    getKeyPair: vi.fn(() => null),
    getPublicKey: vi.fn(() => null),
    selectRecipients: vi.fn(() => RECIPIENTS),
    samePublicKey: vi.fn((a: string, b: string) => a === b),
    encryptPushBodyForDevices: vi.fn(),
    encryptFileForDevices: vi.fn(),
    encryptFileInChunksForDevices: vi.fn(),
}));

import { registerFileTool } from './file.js';
import { ApiError, MAX_FILE_BYTES, type HwipApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import { getKeyPair, getPublicKey, encryptPushBodyForDevices, encryptFileForDevices, encryptFileInChunksForDevices } from '../crypto.js';
import { FILE_CHUNK_CAPABILITY, WHOLE_OPEN_BYTES } from '../file-chunks.js';
import { holdKeyChanges } from '../key-changes.js';

const RECIPIENTS = [{ deviceId: 'dev_phone', publicKey: 'phone-pub' }];
const FILE_KEY_MAP = { dev_phone: '{"encryptedKey":"FILE_WRAPPED","keyIv":"FKIV"}' };
const PUSH_KEY_MAP = { dev_phone: '{"encryptedKey":"PUSH_WRAPPED","keyIv":"PKIV"}' };
const PHONE = { deviceId: 'dev_phone', publicKey: 'phone-pub', type: 'android' };
const CIPHER = Buffer.from('cipherbytes');

const mkConfig = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    sessionId: 'sess_1',
    deviceId: 'dev_default',
    ...over,
});

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

const mkClient = (devices: unknown[] = [PHONE]) => ({
    listDevices: vi.fn(async () => ({ data: devices })),
    registerDeviceKey: vi.fn(async () => ({ data: {} })),
    requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/up' } })),
    uploadToS3: vi.fn(async () => undefined),
    sendPush: vi.fn<HwipApiClient['sendPush']>(async () => ({ data: { pushId: 'push_f' } }) as Awaited<ReturnType<HwipApiClient['sendPush']>>),
});

const runWith = (client: ReturnType<typeof mkClient>, args: Record<string, unknown>, config = mkConfig(), ctx?: unknown) => {
    const { server, run } = captureTool();
    registerFileTool(server, client as unknown as HwipApiClient, config);
    return run(args, ctx);
};

const expectNothingSent = (client: ReturnType<typeof mkClient>) => {
    expect(client.requestUpload).not.toHaveBeenCalled();
    expect(client.uploadToS3).not.toHaveBeenCalled();
    expect(client.sendPush).not.toHaveBeenCalled();
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
    vi.mocked(getPublicKey).mockReturnValue('my-public-key');
    vi.mocked(encryptFileForDevices).mockResolvedValue({ ciphertext: CIPHER, iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP });
    vi.mocked(encryptFileInChunksForDevices).mockResolvedValue({ ciphertext: CIPHER, iv: 'PREFIX7', deviceKeyMap: FILE_KEY_MAP, chunk: 1_048_576 });
    vi.mocked(encryptPushBodyForDevices).mockResolvedValue({ body: 'ENC_BODY', deviceKeyMap: PUSH_KEY_MAP, senderPublicKey: 'SENDER_PUB', isEncrypted: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('registerFileTool', () => {
    it('seals the content and the title, uploads the ciphertext, then sends a sealed file push', async () => {
        const client = mkClient();

        const result = await runWith(client, { fileName: 'hello.txt', content: 'hello' });

        expect(encryptFileForDevices).toHaveBeenCalledWith('hello', RECIPIENTS);
        expect(encryptPushBodyForDevices).toHaveBeenCalledWith({ title: 'proj · hello.txt' }, RECIPIENTS);
        expect(client.requestUpload).toHaveBeenCalledWith({ fileName: 'hello.txt', fileType: 'application/octet-stream', fileSize: CIPHER.length });
        expect(client.uploadToS3).toHaveBeenCalledWith('https://s3/up', CIPHER, 'application/octet-stream');
        expect(client.sendPush).toHaveBeenCalledWith({
            type: 'file',
            targetDeviceId: 'dev_default',
            sessionId: 'sess_1',
            body: 'ENC_BODY',
            isEncrypted: true,
            deviceKeyMap: PUSH_KEY_MAP,
            senderPublicKey: 'SENDER_PUB',
            // `fileSize` and `fileType` describe the plaintext the client renders after opening it.
            files: [{ fileKey: 'fk_1', fileName: 'hello.txt', fileSize: 5, fileType: 'text/plain', iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP }],
        });
        expect(parse(result)).toEqual({ pushId: 'push_f', fileKey: 'fk_1', fileSize: 5, encrypted: true, delivery: 'Sent via cloud' });
    });

    it('threads the file into this tmux session, not a sibling Claude sessionId', async () => {
        const client = mkClient();
        await runWith(
            client,
            { fileName: 'hello.txt', content: 'hello' },
            mkConfig({ agentDeviceId: 'dev_listener_me', agentSessionName: 'hwip-hwipit-3' }),
        );
        expect(client.sendPush).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            agentDeviceId: 'dev_listener_me',
            agentSessionName: 'hwip-hwipit-3',
        }));
    });

    it('seals an explicit title when provided', async () => {
        await runWith(mkClient(), { fileName: 'log.txt', content: 'x', title: 'Crash log' });

        expect(encryptPushBodyForDevices).toHaveBeenCalledWith({ title: 'proj · Crash log' }, RECIPIENTS);
    });

    it('ends the result with a Note for a device whose key changed', async () => {
        holdKeyChanges([{ deviceId: 'dev_phone', at: '2026-10-13T09:00:00.000Z', name: 'iPhone' }]);

        const result = await runWith(mkClient(), { fileName: 'hello.txt', content: 'hello' });

        expect(parse(result).pushId).toBe('push_f');
        expect(result.content[1]).toEqual({ type: 'text', text: 'Note: iPhone changed its encryption key — the new key is trusted. If you did not expect this, check it with: hwip trust' });
    });

    it('still sends, and notes it in the result, when this machine\'s key cannot be registered', async () => {
        const client = mkClient();
        client.registerDeviceKey.mockRejectedValueOnce(new ApiError('forbidden', 'FORBIDDEN', 403));

        const result = await runWith(client, { fileName: 'hello.txt', content: 'hello' });

        expect(parse(result).pushId).toBe('push_f');
        expect(result.content[1]).toEqual({ type: 'text', text: 'Note: could not register this machine\'s key (only an API key with device:write may add it) — the app cannot verify who sent this push' });
    });

    it('does not send a push when the S3 upload fails', async () => {
        const client = mkClient();
        client.uploadToS3.mockRejectedValue(new ApiError('S3 upload failed with status 500', 'UPLOAD_FAILED', 500));

        const result = await runWith(client, { fileName: 'report.txt', content: 'hello' });

        expect(client.sendPush).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('UPLOAD_FAILED');
    });

    it('does not upload or push when requesting the upload URL fails', async () => {
        const client = mkClient();
        client.requestUpload.mockRejectedValue(new ApiError('forbidden', 'FORBIDDEN', 403));

        const result = await runWith(client, { fileName: 'report.txt', content: 'hello' });

        expect(client.uploadToS3).not.toHaveBeenCalled();
        expect(client.sendPush).not.toHaveBeenCalled();
        expect(parse(result).error).toBe('FORBIDDEN');
    });

    it('surfaces a refused send once', async () => {
        const client = mkClient();
        client.sendPush.mockRejectedValue(new ApiError('refused', 'FORBIDDEN', 403));

        const result = await runWith(client, { fileName: 'report.txt', content: 'hello' });

        expect(client.requestUpload).toHaveBeenCalledTimes(1);
        expect(client.uploadToS3).toHaveBeenCalledTimes(1);
        expect(client.sendPush).toHaveBeenCalledTimes(1);
        expect(parse(result).error).toBe('FORBIDDEN');
    });
});

// Binary attachments (screenshots, PDFs) have to reach the device as bytes with
// their real mime type — the clients pick the image viewer off
// `fileType`/extension.
describe('registerFileTool — an abandoned call', () => {
    it('sends nothing when the agent abandoned the call before the file went out', async () => {
        const ac = new AbortController();
        ac.abort();
        const client = mkClient();

        const result = await runWith(client, { fileName: 'a.txt', content: 'hi' }, mkConfig(), { signal: ac.signal, sendNotification: vi.fn() });

        expect(parse(result).error).toBe('CANCELLED');
        expectNothingSent(client);
    });
});

describe('registerFileTool — binary attachments', () => {
    it('seals a local image as its own bytes and names its image mime type', async () => {
        const client = mkClient();
        // A 1x1 PNG on disk — the shape an agent actually holds.
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
        );
        const filePath = join(tmpdir(), 'hwip-test-1x1.png');
        writeFileSync(filePath, png);

        await runWith(client, { filePath });

        expect(encryptFileForDevices).toHaveBeenCalledWith(png, RECIPIENTS);
        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({
                files: [expect.objectContaining({ fileName: 'hwip-test-1x1.png', fileType: 'image/png', fileSize: png.length })],
            }),
        );
    });

    it('rejects a call with neither filePath nor content', async () => {
        const client = mkClient();

        const result = await runWith(client, { title: 'nothing to send' });

        expect(parse(result).error).toBe('INVALID_INPUT');
        expectNothingSent(client);
    });

    it('reports an unreadable filePath instead of pushing', async () => {
        const client = mkClient();

        const result = await runWith(client, { filePath: join(tmpdir(), 'hwip-does-not-exist-9f3a.png') });

        expect(parse(result).error).toBe('FILE_READ_FAILED');
        expectNothingSent(client);
    });

    // M20: the whole file was read into memory before anything asked whether
    // the account could send it, so a stray multi-GB path took the MCP server
    // down. The largest tier cap (Pro, 1 GiB) is the most any send can be.
    it('refuses a file over the cap before reading it', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-big-'));
        try {
            const filePath = join(dir, 'huge.bin');
            writeFileSync(filePath, '');
            truncateSync(filePath, MAX_FILE_BYTES + 1); // sparse: no disk, no memory
            const client = mkClient();

            const result = await runWith(client, { filePath });

            expect(parse(result).error).toBe('FILE_TOO_LARGE');
            expectNothingSent(client);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports a directory as unreadable instead of reading it', async () => {
        const client = mkClient();

        const result = await runWith(client, { filePath: tmpdir() });

        expect(parse(result).error).toBe('FILE_READ_FAILED');
        expect(parse(result).message).toMatch(/not a regular file/i);
        expectNothingSent(client);
    });
});

/**
 * The agent-side sender relays, always.
 *
 * It used to hand a file straight to a target on the same network (ADR-0013),
 * which meant an agent writing a file put it on the user's disk without the
 * user asking for that. The direct route now belongs to the share sheets,
 * where a person picks it; from here every file goes through the cloud, where
 * it stays fetchable by every device on the account.
 */
describe('registerFileTool — the agent sender never goes direct', () => {
    it('uploads and relays even when the target is reachable on this network', async () => {
        // A target that would have passed every old precondition: online, keyed,
        // with a published endpoint, and a sender whose key is the registered one.
        const phone = { deviceId: 'dev_phone', nickname: 'Pixel', type: 'android', publicKey: 'phone-pub', isOnline: true, lan: { host: '192.168.1.20', port: 51234 } };
        const client = mkClient([phone, { deviceId: 'dev_listener_me', publicKey: 'my-public-key', type: 'cli' }]);

        const result = await runWith(client, { fileName: 'report.txt', content: 'hello' }, mkConfig({ deviceId: 'dev_phone', agentDeviceId: 'dev_listener_me' }));

        expect(client.requestUpload).toHaveBeenCalledTimes(1);
        expect(client.uploadToS3).toHaveBeenCalledTimes(1);
        const push = client.sendPush.mock.calls[0][0] as unknown as { files: Record<string, unknown>[] };
        expect(push.files[0].fileKey).toBe('fk_1');
        expect(push.files[0]).not.toHaveProperty('lanDeliveredTo');
        expect(push.files[0]).not.toHaveProperty('transferId');
        expect(parse(result).delivery).toBe('Sent via cloud');
    });
});

// F16: every file is sealed. A step that fails ends the send; nothing goes out in the clear.
describe('registerFileTool — no plaintext', () => {
    it.each([
        ['the content', () => vi.mocked(encryptFileForDevices).mockRejectedValueOnce(new Error('import failed'))],
        ['the title', () => vi.mocked(encryptPushBodyForDevices).mockRejectedValueOnce(new Error('import failed'))],
    ])('uploads and sends nothing when sealing %s fails', async (_, fail) => {
        fail();
        const client = mkClient();

        const result = await runWith(client, { fileName: 'report.txt', content: 'hello' });

        expect(parse(result)).toEqual({ error: 'E2E_REQUIRED', message: 'sealing the file failed; nothing was sent' });
        expectNothingSent(client);
    });

    it.each([
        ['times out', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
        ['answers 5xx', new ApiError('Service Unavailable', 'HTTP_503', 503)],
        ['cannot be reached', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })],
    ])('uploads and sends nothing when the device list %s', async (_, err) => {
        const client = mkClient();
        client.listDevices.mockRejectedValue(err);

        const result = await runWith(client, { fileName: 'report.txt', content: 'hello' });

        expect(parse(result)).toEqual({ error: 'E2E_REQUIRED', message: 'the device list could not be read; nothing was sent' });
        expect(encryptFileForDevices).not.toHaveBeenCalled();
        expectNothingSent(client);
    });

    it('uploads and sends nothing when this machine has no keys', async () => {
        vi.mocked(getKeyPair).mockReturnValue(null);
        vi.mocked(getPublicKey).mockReturnValue(null);
        const client = mkClient();

        const result = await runWith(client, { fileName: 'report.txt', content: 'hello' });

        expect(parse(result).error).toBe('E2E_REQUIRED');
        expectNothingSent(client);
    });

    it('uploads and sends nothing to an account with no iPhone or Android app', async () => {
        const client = mkClient([{ deviceId: 'dev_pc', publicKey: 'pc-pub', type: 'cli' }]);

        const result = await runWith(client, { fileName: 'report.txt', content: 'hello' });

        expect(parse(result)).toEqual({ error: 'NO_APP_DEVICE', message: 'sign in to the Hwip app on an iPhone or Android phone' });
        expectNothingSent(client);
    });
});

// Several screenshots asked for at once came as one push each: a bubble per picture. `filePaths` carries them
// together, as many to a push as the server takes.
describe('registerFileTool — several files', () => {
    const writeFiles = (count: number) => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-many-'));
        const paths = Array.from({ length: count }, (_, i) => {
            const path = join(dir, `shot-${i + 1}.png`);
            writeFileSync(path, `png-${i + 1}`);
            return path;
        });
        return { paths, done: () => rmSync(dir, { recursive: true, force: true }) };
    };

    it('sends every file in one push, each sealed and uploaded', async () => {
        const { paths, done } = writeFiles(3);
        try {
            const client = mkClient();
            client.requestUpload
                .mockResolvedValueOnce({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/1' } })
                .mockResolvedValueOnce({ data: { fileId: 'f2', fileKey: 'fk_2', uploadUrl: 'https://s3/2' } })
                .mockResolvedValueOnce({ data: { fileId: 'f3', fileKey: 'fk_3', uploadUrl: 'https://s3/3' } });

            const result = await runWith(client, { filePaths: paths, title: 'Lounge' });

            expect(encryptFileForDevices).toHaveBeenCalledTimes(3);
            expect(client.uploadToS3).toHaveBeenCalledTimes(3);
            expect(encryptPushBodyForDevices).toHaveBeenCalledTimes(1);
            expect(encryptPushBodyForDevices).toHaveBeenCalledWith({ title: 'proj · Lounge' }, RECIPIENTS);
            expect(client.sendPush).toHaveBeenCalledTimes(1);
            const files = client.sendPush.mock.calls[0][0].files!;
            expect(files.map((f) => [f.fileKey, f.fileName, f.fileType])).toEqual([
                ['fk_1', 'shot-1.png', 'image/png'],
                ['fk_2', 'shot-2.png', 'image/png'],
                ['fk_3', 'shot-3.png', 'image/png'],
            ]);
            expect(parse(result)).toEqual({ pushIds: ['push_f'], fileCount: 3, encrypted: true, delivery: 'Sent via cloud' });
        } finally {
            done();
        }
    });

    it('names a push of several files by their count when no title is given', async () => {
        const { paths, done } = writeFiles(2);
        try {
            await runWith(mkClient(), { filePaths: paths });

            expect(encryptPushBodyForDevices).toHaveBeenCalledWith({ title: 'proj · 2 files' }, RECIPIENTS);
        } finally {
            done();
        }
    });

    it('splits more files than a push takes into pushes of five, in order', async () => {
        const { paths, done } = writeFiles(7);
        try {
            const client = mkClient();
            client.sendPush
                .mockResolvedValueOnce({ data: { pushId: 'push_a' } } as Awaited<ReturnType<HwipApiClient['sendPush']>>)
                .mockResolvedValueOnce({ data: { pushId: 'push_b' } } as Awaited<ReturnType<HwipApiClient['sendPush']>>);

            const result = await runWith(client, { filePaths: paths, title: 'Shots' });

            expect(client.sendPush.mock.calls.map(([push]) => push.files!.map((f) => f.fileName))).toEqual([
                ['shot-1.png', 'shot-2.png', 'shot-3.png', 'shot-4.png', 'shot-5.png'],
                ['shot-6.png', 'shot-7.png'],
            ]);
            expect(vi.mocked(encryptPushBodyForDevices).mock.calls.map(([body]) => body)).toEqual([
                { title: 'proj · Shots (1/2)' },
                { title: 'proj · Shots (2/2)' },
            ]);
            expect(parse(result)).toEqual({ pushIds: ['push_a', 'push_b'], fileCount: 7, encrypted: true, delivery: 'Sent via cloud' });
        } finally {
            done();
        }
    });

    it('sends nothing when any one of the files cannot be read', async () => {
        const { paths, done } = writeFiles(2);
        try {
            const client = mkClient();

            const result = await runWith(client, { filePaths: [...paths, join(tmpdir(), 'hwip-missing-7c1e.png')] });

            expect(parse(result).error).toBe('FILE_READ_FAILED');
            expectNothingSent(client);
        } finally {
            done();
        }
    });

    it('stops between pushes when the agent abandons the call, naming how many went out', async () => {
        const { paths, done } = writeFiles(7);
        try {
            const ac = new AbortController();
            const client = mkClient();
            client.sendPush.mockImplementationOnce(async () => {
                ac.abort();
                return { data: { pushId: 'push_a' } } as Awaited<ReturnType<HwipApiClient['sendPush']>>;
            });

            const result = await runWith(client, { filePaths: paths }, mkConfig(), { signal: ac.signal, sendNotification: vi.fn() });

            expect(parse(result).error).toBe('CANCELLED');
            expect(parse(result).message).toContain('after 1 of 2 pushes');
            expect(client.sendPush).toHaveBeenCalledTimes(1);
        } finally {
            done();
        }
    });

    it('refuses filePaths together with filePath or content', async () => {
        const { paths, done } = writeFiles(1);
        try {
            const client = mkClient();

            const withPath = await runWith(client, { filePaths: paths, filePath: paths[0] });
            const withContent = await runWith(client, { filePaths: paths, content: 'x', fileName: 'x.txt' });

            expect(parse(withPath).error).toBe('INVALID_INPUT');
            expect(parse(withContent).error).toBe('INVALID_INPUT');
            expectNothingSent(client);
        } finally {
            done();
        }
    });
});

describe('registerFileTool — a file over what a phone opens sealed whole', () => {
    const CHUNK_PHONE = { ...PHONE, nickname: 'Pixel', capabilities: [FILE_CHUNK_CAPABILITY] };
    const OLD_PHONE = { deviceId: 'dev_old', publicKey: 'old-pub', type: 'ios', nickname: 'Old iPhone' };
    let dir: string;
    let big: string;
    let small: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'hwip-chunk-'));
        big = join(dir, 'scan.pdf');
        writeFileSync(big, '');
        truncateSync(big, WHOLE_OPEN_BYTES); // over the whole cap once the tag is counted
        small = join(dir, 'notes.txt');
        writeFileSync(small, 'hi');
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('seals it in chunks when every device it goes to opens them, and names it in the sealed file list', async () => {
        const client = mkClient([CHUNK_PHONE]);

        const result = await runWith(client, { filePath: big }, mkConfig({ deviceId: undefined }));

        expect(encryptFileInChunksForDevices).toHaveBeenCalledTimes(1);
        expect(encryptFileForDevices).not.toHaveBeenCalled();
        expect(encryptPushBodyForDevices).toHaveBeenCalledWith({
            title: 'proj · scan.pdf',
            files: [{ iv: 'PREFIX7', name: 'scan.pdf', type: 'application/pdf', size: WHOLE_OPEN_BYTES, chunk: 1_048_576 }],
        }, RECIPIENTS);
        expect(client.sendPush).toHaveBeenCalledWith(expect.objectContaining({
            files: [expect.objectContaining({ fileName: 'scan.pdf', fileSize: WHOLE_OPEN_BYTES, iv: 'PREFIX7' })],
        }));
        expect(parse(result).pushId).toBe('push_f');
    });

    it('refuses it, sending nothing, when a device it goes to does not open chunks', async () => {
        const client = mkClient([CHUNK_PHONE, OLD_PHONE]);

        const result = await runWith(client, { filePath: big }, mkConfig({ deviceId: undefined }));

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('FILE_TOO_LARGE');
        expect(parse(result).message).toContain('Old iPhone');
        expect(encryptFileInChunksForDevices).not.toHaveBeenCalled();
        expectNothingSent(client);
    });

    it('sends it to the one device it targets when that one opens chunks', async () => {
        const client = mkClient([CHUNK_PHONE, OLD_PHONE]);

        const result = await runWith(client, { filePath: big, targetDeviceId: 'dev_phone' });

        expect(parse(result).pushId).toBe('push_f');
        expect(encryptFileInChunksForDevices).toHaveBeenCalledTimes(1);
    });

    it('refuses a set with one big file before any of it is sent', async () => {
        const client = mkClient([OLD_PHONE]);

        const result = await runWith(client, { filePaths: [small, big] }, mkConfig({ deviceId: undefined }));

        expect(parse(result).error).toBe('FILE_TOO_LARGE');
        expectNothingSent(client);
    });

    it('lists every file of a push with a chunked one, and seals the small one whole', async () => {
        const client = mkClient([CHUNK_PHONE]);

        await runWith(client, { filePaths: [small, big] }, mkConfig({ deviceId: undefined }));

        expect(encryptFileForDevices).toHaveBeenCalledTimes(1);
        expect(encryptFileInChunksForDevices).toHaveBeenCalledTimes(1);
        expect(encryptPushBodyForDevices).toHaveBeenCalledWith(expect.objectContaining({
            files: [
                { iv: 'FILE_IV', name: 'notes.txt', type: 'text/plain', size: 2 },
                { iv: 'PREFIX7', name: 'scan.pdf', type: 'application/pdf', size: WHOLE_OPEN_BYTES, chunk: 1_048_576 },
            ],
        }), RECIPIENTS);
    });

    it('keeps a push of small files as it was: sealed whole, with no file list', async () => {
        await runWith(mkClient([CHUNK_PHONE]), { filePath: small });

        expect(encryptFileInChunksForDevices).not.toHaveBeenCalled();
        expect(encryptPushBodyForDevices).toHaveBeenCalledWith({ title: 'proj · notes.txt' }, RECIPIENTS);
    });
});

describe('registerFileTool — hwip state files', () => {
    const originalHome = process.env.HOME;
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'hwip-home-'));
        mkdirSync(join(home, '.hwip', 'attachments', 'hevt_1'), { recursive: true });
        process.env.HOME = home;
    });
    afterEach(() => {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        rmSync(home, { recursive: true, force: true });
    });

    it.each(['config.json', 'device-keys.json', 'trusted-devices.json'])('refuses ~/.hwip/%s and sends nothing', async (name) => {
        const secret = join(home, '.hwip', name);
        writeFileSync(secret, '{"apiKey":"x"}');
        const client = mkClient();

        const result = await runWith(client, { filePath: secret });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('INVALID_INPUT');
        expectNothingSent(client);
    });

    it('refuses the same file through a symlink, and in a filePaths list', async () => {
        const secret = join(home, '.hwip', 'device-keys.json');
        writeFileSync(secret, '{}');
        const link = join(home, 'innocent.txt');
        symlinkSync(secret, link);
        const client = mkClient();

        expect(parse(await runWith(client, { filePath: link })).error).toBe('INVALID_INPUT');
        expect(parse(await runWith(client, { filePaths: [link] })).error).toBe('INVALID_INPUT');
        expectNothingSent(client);
    });

    it('still sends an answer attachment saved under ~/.hwip/attachments', async () => {
        const shot = join(home, '.hwip', 'attachments', 'hevt_1', 'shot.png');
        writeFileSync(shot, 'png');
        const client = mkClient();

        const result = await runWith(client, { filePath: shot });

        expect(result.isError).toBeUndefined();
        expect(client.sendPush).toHaveBeenCalledTimes(1);
    });
});

describe('registerFileTool — a send that stops part way', () => {
    it('names the pushes that already went when a later push fails', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-part-'));
        try {
            const paths = Array.from({ length: 7 }, (_, i) => {
                const path = join(dir, `shot-${i + 1}.png`);
                writeFileSync(path, 'png');
                return path;
            });
            const client = mkClient();
            client.sendPush
                .mockResolvedValueOnce({ data: { pushId: 'push_a' } } as Awaited<ReturnType<HwipApiClient['sendPush']>>)
                .mockRejectedValueOnce(new ApiError('boom', 'SERVER_ERROR', 500));

            const result = await runWith(client, { filePaths: paths });

            expect(result.isError).toBe(true);
            const body = parse(result);
            expect(body.message).toContain('push_a');
            expect(body.message).toContain('boom');
            expect(body.sentPushIds).toEqual(['push_a']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// The caps the tool answers at: the schema's path cap and the memory cap on what is read.
describe('registerFileTool — caps', () => {
    const CHUNKY = { deviceId: 'dev_phone', publicKey: 'phone-pub', type: 'android', capabilities: [FILE_CHUNK_CAPABILITY] };
    const CHUNK_PHONE = { deviceId: 'dev_phone', publicKey: 'phone-pub', type: 'android', capabilities: [FILE_CHUNK_CAPABILITY] };
    it('takes at most 20 file paths', () => {
        let schema: Record<string, { parse: (v: unknown) => unknown }> | undefined;
        const server = {
            registerTool: (_n: string, cfg: { inputSchema: Record<string, { parse: (v: unknown) => unknown }> }) => { schema = cfg.inputSchema; },
        } as unknown as McpServer;
        registerFileTool(server, mkClient() as unknown as HwipApiClient, mkConfig());
        const paths = Array.from({ length: 20 }, (_, i) => `/tmp/hwip-f${i}.txt`);
        expect(schema!.filePaths.parse(paths)).toEqual(paths);
        expect(() => schema!.filePaths.parse([...paths, '/tmp/hwip-f20.txt'])).toThrow();
    });

    it('reads a file of exactly the largest size hwip carries', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-cap-'));
        try {
            const exact = join(dir, 'exact.bin');
            writeFileSync(exact, '');
            truncateSync(exact, MAX_FILE_BYTES);
            const client = mkClient([CHUNKY]);

            // The second path is unreadable, so nothing of the 1 GiB file is ever read in: the check
            // happens path by path before any read.
            const result = await runWith(client, { filePaths: [exact, join(dir, 'missing.bin')] }, mkConfig({ deviceId: undefined }));

            expect(parse(result).error).toBe('FILE_READ_FAILED');
            expect(parse(result).message).not.toContain('the most hwip carries');
            expectNothingSent(client);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('refuses a file one byte past the largest size hwip carries', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-cap-'));
        try {
            const over = join(dir, 'over.bin');
            writeFileSync(over, '');
            truncateSync(over, MAX_FILE_BYTES + 1);
            const client = mkClient([CHUNKY]);

            const result = await runWith(client, { filePaths: [over] }, mkConfig({ deviceId: undefined }));

            expect(parse(result).error).toBe('FILE_TOO_LARGE');
            expect(parse(result).message).toContain(`the most hwip carries is ${MAX_FILE_BYTES}`);
            expectNothingSent(client);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('registerFileTool — several files, when a push is refused', () => {
    it('answers the audience refusal as itself, sending nothing', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-many-'));
        const paths = Array.from({ length: 2 }, (_, i) => {
            const path = join(dir, `shot-${i + 1}.png`);
            writeFileSync(path, `png-${i + 1}`);
            return path;
        });
        try {
            // No iPhone or Android app on the account: resolveAudience refuses the whole send.
            const client = mkClient([{ deviceId: 'dev_pc', publicKey: 'pc-pub', type: 'cli' }]);

            const result = await runWith(client, { filePaths: paths, title: 'Shots' });

            expect(parse(result).error).toBe('NO_APP_DEVICE');
            expectNothingSent(client);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('says which pushes already went out when a later push is refused', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-many-'));
        const paths = Array.from({ length: 6 }, (_, i) => {
            const path = join(dir, `shot-${i + 1}.png`);
            writeFileSync(path, `png-${i + 1}`);
            return path;
        });
        try {
            const client = mkClient();
            const sealed = { ciphertext: CIPHER, iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP } as Awaited<ReturnType<typeof encryptFileForDevices>>;
            vi.mocked(encryptFileForDevices)
                .mockResolvedValueOnce(sealed).mockResolvedValueOnce(sealed).mockResolvedValueOnce(sealed)
                .mockResolvedValueOnce(sealed).mockResolvedValueOnce(sealed)
                .mockRejectedValueOnce(new Error('import failed'));

            const result = await runWith(client, { filePaths: paths, title: 'Shots' });

            const body = parse(result);
            expect(body.error).toBe('E2E_REQUIRED');
            expect(body.message).toContain('1 of 2 pushes had already gone out');
            expect(body.sentPushIds).toEqual(['push_f']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('names no pushes as gone when the refusal came before any', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-many-'));
        const paths = Array.from({ length: 1 }, (_, i) => {
            const path = join(dir, `shot-${i + 1}.png`);
            writeFileSync(path, `png-${i + 1}`);
            return path;
        });
        try {
            const client = mkClient();
            vi.mocked(encryptFileForDevices).mockRejectedValueOnce(new Error('import failed'));

            const result = await runWith(client, { filePaths: paths, title: 'Shots' });

            expect(parse(result)).toEqual({ error: 'E2E_REQUIRED', message: 'sealing the file failed; nothing was sent' });
            expectNothingSent(client);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
