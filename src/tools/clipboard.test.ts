import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { registerClipboardTool } from './clipboard.js';
import { ApiError, type HwipApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';

const config: McpServerConfig = {
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    sessionId: 'sess_1',
    deviceId: 'dev_default',
};

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe('registerClipboardTool', () => {
    it('sends a clipboard-type push to the default device', async () => {
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'pc' } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerClipboardTool(server, client as unknown as HwipApiClient, config);

        const result = await run({ text: 'copy me' });

        expect(client.sendPush).toHaveBeenCalledWith({
            title: 'Clipboard',
            body: 'copy me',
            type: 'clipboard',
            targetDeviceId: 'dev_default',
            sessionId: 'sess_1',
        });
        expect(parse(result)).toEqual({ pushId: 'pc' });
    });

    // The server's cap (hwip server/src/lib/push-input.ts): the body as JSON text, UTF-8, quotes not counted.
    it.each([
        ['a', 96 * 1024, false],
        ['a', 96 * 1024 + 1, true],
        ['가', 32 * 1024, false],
        ['가', 32 * 1024 + 1, true],
        ['\n', 48 * 1024 + 1, true],
    ])('refuses %j × %i over 96 KiB before sending: %s', async (char, count, refused) => {
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'pc' } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerClipboardTool(server, client as unknown as HwipApiClient, config);

        const result = await run({ text: char.repeat(count) });

        expect(client.sendPush).toHaveBeenCalledTimes(refused ? 0 : 1);
        expect(result.isError ?? false).toBe(refused);
        if (refused) expect(parse(result)).toMatchObject({ error: 'BODY_TOO_LONG', suggestion: expect.stringContaining('hwip_file') });
    });

    it('routes to an explicit targetDeviceId when given', async () => {
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'pc' } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerClipboardTool(server, client as unknown as HwipApiClient, config);

        await run({ text: 'x', targetDeviceId: 'dev_explicit' });

        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({ targetDeviceId: 'dev_explicit' }),
        );
    });

    it('formats an ApiError into a structured error result', async () => {
        const client = {
            sendPush: vi.fn(async () => {
                throw new ApiError('nope', 'UNAUTHORIZED', 401);
            }),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerClipboardTool(server, client as unknown as HwipApiClient, config);

        const result = await run({ text: 'x' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('UNAUTHORIZED');
    });
});
