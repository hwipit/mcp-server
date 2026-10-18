import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { registerBroadcastTool } from './broadcast.js';
import { ApiError, type HwipApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';

const config: McpServerConfig = {
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    sessionId: 'sess_1',
};

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe('registerBroadcastTool', () => {
    it('sends a channel push without project-prefixing the title', async () => {
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'pb' } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerBroadcastTool(server, client as unknown as HwipApiClient, config);

        const result = await run({ channelId: 'ch_1', title: 'Release', body: 'v2 is out', priority: 'normal' });

        expect(client.sendPush).toHaveBeenCalledWith({
            title: 'Release',
            body: 'v2 is out',
            url: undefined,
            type: 'hook',
            priority: 'normal',
            channelId: 'ch_1',
            sessionId: 'sess_1',
        });
        expect(parse(result)).toEqual({ pushId: 'pb', channelId: 'ch_1' });
    });

    it('formats an ApiError into a structured error result', async () => {
        const client = {
            sendPush: vi.fn(async () => {
                throw new ApiError('forbidden', 'FORBIDDEN', 403);
            }),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerBroadcastTool(server, client as unknown as HwipApiClient, config);

        const result = await run({ channelId: 'ch_1', title: 'T', priority: 'normal' });

        expect(result.isError).toBe(true);
        const body = parse(result);
        expect(body.error).toBe('FORBIDDEN');
        expect(body.suggestion).toMatch(/scopes/);
    });
});
