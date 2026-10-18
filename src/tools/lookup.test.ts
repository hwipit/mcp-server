import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLookupTools } from './lookup.js';
import { ApiError, type HwipApiClient } from '../api-client.js';

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

/** registerLookupTools registers two tools; keep each handler by name. */
const capture = (client: Partial<HwipApiClient>) => {
    const handlers = new Map<string, () => Promise<CallToolResult>>();
    const server = {
        registerTool: (name: string, _config: unknown, h: () => Promise<CallToolResult>) => { handlers.set(name, h); },
    } as unknown as McpServer;
    registerLookupTools(server, client as HwipApiClient); // stub: only the methods the test drives
    return (name: string) => handlers.get(name)!();
};

describe('registerLookupTools', () => {
    it('lists devices for hwip_notify targeting', async () => {
        const devices = [{ deviceId: 'dev_1', name: 'Phone', isOnline: true }];
        const run = capture({ listDevices: vi.fn(async () => ({ data: devices })) as never });

        expect(parse(await run('hwip_devices'))).toEqual({ devices });
    });

    it('lists channels for hwip_broadcast', async () => {
        const channels = [{ channelId: 'ch_1', name: 'deploys' }];
        const run = capture({ listChannels: vi.fn(async () => ({ data: channels })) as never });

        expect(parse(await run('hwip_channels'))).toEqual({ channels });
    });

    it('returns a structured error when the API refuses', async () => {
        const run = capture({ listDevices: vi.fn(async () => { throw new ApiError('bad key', 'UNAUTHORIZED', 401); }) });

        const result = await run('hwip_devices');
        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('UNAUTHORIZED');
    });
});
