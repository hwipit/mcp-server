import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';

// Mock crypto: the real getKeyPair()/getPublicKey() only return non-null after
// initCrypto() has loaded this machine's keypair, which we never do here. Every test
// starts with keys; the ones about a machine without them take them away.
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
}));

const RECIPIENTS = [{ deviceId: 'dev_phone', publicKey: 'phone-pub' }];
const DEVICE_KEY_MAP = { dev_phone: '{"encryptedKey":"WRAPPED","keyIv":"KIV"}' };
const FILE_KEY_MAP = { dev_phone: '{"encryptedKey":"FILE_WRAPPED","keyIv":"FKIV"}' };
const PHONE = { deviceId: 'dev_phone', publicKey: 'phone-pub', type: 'ios' };

import { registerNotifyTool } from './notify.js';
import { ApiError, type HwipApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import { getKeyPair, getPublicKey, encryptFileForDevices, encryptPushBodyForDevices } from '../crypto.js';
import { observeDevices } from '../trust-pins.js';
import { holdKeyChanges } from '../key-changes.js';

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
    registerDeviceKey: vi.fn<HwipApiClient['registerDeviceKey']>(async () => ({ data: PHONE }) as Awaited<ReturnType<HwipApiClient['registerDeviceKey']>>),
    requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'key_1', uploadUrl: 'https://s3/put' } })),
    uploadToS3: vi.fn(async () => undefined),
    sendPush: vi.fn<HwipApiClient['sendPush']>(async () => ({ data: { pushId: 'push_1' } }) as Awaited<ReturnType<HwipApiClient['sendPush']>>),
});

const runWith = (client: ReturnType<typeof mkClient>, args: Record<string, unknown>, config = mkConfig()) => {
    const { server, run } = captureTool();
    registerNotifyTool(server, client as unknown as HwipApiClient, config);
    return run({ priority: 'normal', ...args });
};

/** Nothing reached the server: no upload address, no upload, no push. */
const expectNothingSent = (client: ReturnType<typeof mkClient>) => {
    expect(client.requestUpload).not.toHaveBeenCalled();
    expect(client.uploadToS3).not.toHaveBeenCalled();
    expect(client.sendPush).not.toHaveBeenCalled();
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
    vi.mocked(getPublicKey).mockReturnValue('my-public-key');
    vi.mocked(encryptPushBodyForDevices).mockResolvedValue({
        body: 'ENC_BODY',
        deviceKeyMap: DEVICE_KEY_MAP,
        senderPublicKey: 'SENDER_PUB',
        isEncrypted: true,
    });
    vi.mocked(encryptFileForDevices).mockResolvedValue({ ciphertext: Buffer.from('CIPHER'), iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP } as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('registerNotifyTool', () => {
    it('seals a short-body push: title, body and url only inside the envelope', async () => {
        const client = mkClient();

        const result = await runWith(client, { title: 'Build done', body: 'short body', url: 'https://secret.example.com/x' });

        expect(encryptPushBodyForDevices).toHaveBeenCalledWith(
            { title: 'proj · Build done', body: 'short body', url: 'https://secret.example.com/x' },
            RECIPIENTS,
        );
        expect(client.requestUpload).not.toHaveBeenCalled();
        expect(client.sendPush).toHaveBeenCalledWith({
            body: 'ENC_BODY',
            type: 'hook',
            priority: 'normal',
            targetDeviceId: 'dev_default',
            sessionId: 'sess_1',
            isEncrypted: true,
            deviceKeyMap: DEVICE_KEY_MAP,
            senderPublicKey: 'SENDER_PUB',
        });
        expect(parse(result)).toEqual({ pushId: 'push_1', encrypted: true });
        expect(result.isError).toBeUndefined();
    });

    it('puts this machine\'s key on the account\'s list once when the list lacks it, then sends', async () => {
        const client = mkClient();

        await runWith(client, { title: 'Build done', body: 'short body' });

        expect(client.registerDeviceKey).toHaveBeenCalledTimes(1);
        expect(client.listDevices).toHaveBeenCalledTimes(1);
        expect(client.sendPush).toHaveBeenCalledTimes(1);
    });

    it('still sends, with one line on stderr, when this machine\'s key cannot be registered', async () => {
        const client = mkClient();
        client.registerDeviceKey.mockRejectedValueOnce(new ApiError('forbidden', 'FORBIDDEN', 403));

        const result = await runWith(client, { title: 'Build done', body: 'short body' });

        expect(parse(result)).toEqual({ pushId: 'push_1', encrypted: true });
        expect(console.error).toHaveBeenCalledWith('[hwip] could not register this machine\'s key (the server answered HTTP 403) — the app cannot verify who sent this push');
        // This server's stderr reaches nobody: the result the agent reads says it.
        expect(result.content[1]).toEqual({ type: 'text', text: 'Note: could not register this machine\'s key (the server answered HTTP 403) — the app cannot verify who sent this push' });
    });

    it('notes a registration that keeps failing the same way once per process, and stderr every time', async () => {
        const client = mkClient();
        client.registerDeviceKey.mockRejectedValue(new ApiError('not found', 'NOT_FOUND', 404));

        const first = await runWith(client, { title: 'T', body: 'b' });
        const second = await runWith(client, { title: 'T', body: 'b' });

        expect(first.content[1]).toEqual({ type: 'text', text: 'Note: could not register this machine\'s key (the server answered HTTP 404) — the app cannot verify who sent this push' });
        expect(second.content).toHaveLength(1);
        expect(client.sendPush).toHaveBeenCalledTimes(2);
        expect(vi.mocked(console.error).mock.calls.filter(([line]) => String(line).includes('HTTP 404'))).toHaveLength(2);
    });

    it('honors an explicit targetDeviceId over the configured default', async () => {
        const client = mkClient();

        await runWith(client, { title: 'T', body: 'b', priority: 'high', targetDeviceId: 'dev_explicit' });

        expect(client.sendPush).toHaveBeenCalledWith(expect.objectContaining({ targetDeviceId: 'dev_explicit', priority: 'high' }));
    });

    // This server's stderr reaches nobody: a key the send saw change is said in the result the agent reads.
    it('ends the result with a Note for a device whose key changed, once', async () => {
        vi.mocked(observeDevices).mockImplementationOnce(() => {
            holdKeyChanges([{ deviceId: 'dev_phone', at: '2026-10-13T09:00:00.000Z', name: 'iPhone' }]);
            return { pinned: [], replaced: ['dev_phone'], skipped: [], status: 'unlocked' };
        });
        const client = mkClient();

        const first = await runWith(client, { title: 'T', body: 'b' });
        const second = await runWith(client, { title: 'T', body: 'b' });

        expect(parse(first)).toEqual({ pushId: 'push_1', encrypted: true });
        expect(first.content[1]).toEqual({ type: 'text', text: 'Note: iPhone changed its encryption key — the new key is trusted. If you did not expect this, check it with: hwip trust' });
        expect(second.content).toHaveLength(1);
    });

    it('uploads the sealed full text and sends a sealed preview when the body exceeds the preview length', async () => {
        const longBody = 'x'.repeat(250);
        const client = mkClient();

        const result = await runWith(client, { title: 'Report', body: longBody });

        expect(encryptFileForDevices).toHaveBeenCalledWith(`# Report\n\n${longBody}`, RECIPIENTS);
        expect(encryptPushBodyForDevices).toHaveBeenCalledWith({ title: 'proj · Report', body: `${'x'.repeat(200)}...`, url: undefined }, RECIPIENTS);
        // The address is signed for the type given to requestUpload; the PUT has to carry the same one (S113).
        expect(client.requestUpload).toHaveBeenCalledWith({ fileName: 'response.md', fileType: 'application/octet-stream', fileSize: 6 });
        expect(client.uploadToS3).toHaveBeenCalledWith('https://s3/put', Buffer.from('CIPHER'), 'application/octet-stream');
        const push = client.sendPush.mock.calls[0][0] as unknown as Record<string, unknown>;
        expect(push).toEqual(expect.objectContaining({
            type: 'file',
            body: 'ENC_BODY',
            isEncrypted: true,
            files: [expect.objectContaining({ fileKey: 'key_1', fileName: 'response.md', fileType: 'text/markdown', iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP })],
            targetDeviceId: 'dev_default',
        }));
        expect(push.title).toBeUndefined();
        expect(push.url).toBeUndefined();
        expect(parse(result)).toEqual({ pushId: 'push_1', fileKey: 'key_1', autoFile: true, encrypted: true });
    });

    it.each([
        ['a short body', 'b'],
        ['a long body sent as a file', 'x'.repeat(250)],
    ])('threads %s into this tmux session, not a sibling Claude sessionId', async (_, body) => {
        const client = mkClient();
        await runWith(
            client,
            { title: 'T', body },
            mkConfig({ agentDeviceId: 'dev_listener_me', agentSessionName: 'hwip-hwipit-3' }),
        );
        expect(client.sendPush).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            agentDeviceId: 'dev_listener_me',
            agentSessionName: 'hwip-hwipit-3',
        }));
    });

    it('strips leaked tool-call markup from the body before sealing', async () => {
        await runWith(mkClient(), { title: 'T', body: 'real text</body>\n<parameter name="x">junk' });

        expect(encryptPushBodyForDevices).toHaveBeenCalledWith(expect.objectContaining({ body: 'real text' }), RECIPIENTS);
    });

    it('formats an ApiError into a structured error result', async () => {
        const client = mkClient();
        client.sendPush.mockRejectedValue(new ApiError('over limit', 'QUOTA_EXCEEDED', 403));

        const result = await runWith(client, { title: 'T', body: 'b' });

        expect(result.isError).toBe(true);
        const body = parse(result);
        expect(body.error).toBe('QUOTA_EXCEEDED');
        expect(body.suggestion).toMatch(/Upgrade/);
    });

    it('surfaces a refused send once', async () => {
        const client = mkClient();
        client.sendPush.mockRejectedValue(new ApiError('refused', 'FORBIDDEN', 403));

        const result = await runWith(client, { title: 'Secret', body: 'classified' });

        expect(client.sendPush).toHaveBeenCalledTimes(1);
        expect(parse(result).error).toBe('FORBIDDEN');
    });
});

// F16: every notification is sealed. A step that fails ends the send; nothing goes out in the clear.
describe('registerNotifyTool — no plaintext', () => {
    it('sends nothing when sealing a short body fails', async () => {
        vi.mocked(encryptPushBodyForDevices).mockRejectedValueOnce(new Error('import failed'));
        const client = mkClient();

        const result = await runWith(client, { title: 'Secret', body: 'classified' });

        expect(result.isError).toBe(true);
        expect(parse(result)).toEqual({ error: 'E2E_REQUIRED', message: 'sealing the notification failed; nothing was sent' });
        expectNothingSent(client);
    });

    it.each([
        ['the file', () => vi.mocked(encryptFileForDevices).mockRejectedValueOnce(new Error('import failed'))],
        ['the preview', () => vi.mocked(encryptPushBodyForDevices).mockRejectedValueOnce(new Error('import failed'))],
    ])('uploads and sends nothing when sealing %s of a long body fails', async (_, fail) => {
        fail();
        const client = mkClient();

        const result = await runWith(client, { title: 'Secret', body: 'x'.repeat(500) });

        expect(parse(result).error).toBe('E2E_REQUIRED');
        expectNothingSent(client);
    });

    it.each([
        ['times out', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
        ['answers 5xx', new ApiError('Service Unavailable', 'HTTP_503', 503)],
        ['cannot be reached', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })],
    ])('sends nothing when the device list %s', async (_, err) => {
        const client = mkClient();
        client.listDevices.mockRejectedValue(err);

        const result = await runWith(client, { title: 'Secret', body: 'classified' });

        expect(parse(result)).toEqual({ error: 'E2E_REQUIRED', message: 'the device list could not be read; nothing was sent' });
        expect(encryptPushBodyForDevices).not.toHaveBeenCalled();
        expectNothingSent(client);
    });

    it('sends nothing when this machine has no keys', async () => {
        vi.mocked(getKeyPair).mockReturnValue(null);
        vi.mocked(getPublicKey).mockReturnValue(null);
        const client = mkClient();

        const result = await runWith(client, { title: 'Secret', body: 'classified' });

        expect(parse(result).error).toBe('E2E_REQUIRED');
        expectNothingSent(client);
    });

    it('sends nothing to an account with no iPhone or Android app', async () => {
        const client = mkClient([{ deviceId: 'dev_pc', publicKey: 'pc-pub', type: 'cli' }, { deviceId: 'dev_mac', publicKey: 'mac-pub', type: 'macos' }]);

        const result = await runWith(client, { title: 'Secret', body: 'classified' });

        expect(result.isError).toBe(true);
        expect(parse(result)).toEqual({ error: 'NO_APP_DEVICE', message: 'sign in to the Hwip app on an iPhone or Android phone' });
        expectNothingSent(client);
    });
});
