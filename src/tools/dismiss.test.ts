import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { registerDismissTool, registerDismissAllTool } from './dismiss.js';
import { ApiError, type HwipApiClient } from '../api-client.js';

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe('registerDismissTool', () => {
    it('dismisses a single push by id', async () => {
        const client = {
            dismissPush: vi.fn(async () => ({ data: { dismissed: true } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerDismissTool(server, client as unknown as HwipApiClient);

        const result = await run({ pushId: 'push_x' });

        expect(client.dismissPush).toHaveBeenCalledWith('push_x');
        expect(parse(result)).toEqual({ dismissed: true, pushId: 'push_x' });
    });

    it('formats an ApiError into a structured error result', async () => {
        const client = {
            dismissPush: vi.fn(async () => {
                throw new ApiError('boom', 'UNKNOWN_ERROR', 500);
            }),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerDismissTool(server, client as unknown as HwipApiClient);

        const result = await run({ pushId: 'push_x' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('UNKNOWN_ERROR');
    });
});

describe('registerDismissAllTool', () => {
    it('dismisses all pushes and reports the count and badge', async () => {
        const client = {
            dismissAllPushes: vi.fn(async () => ({ data: { dismissed: 5, badge: 0 } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerDismissAllTool(server, client as unknown as HwipApiClient);

        const result = await run({});

        expect(client.dismissAllPushes).toHaveBeenCalled();
        expect(parse(result)).toEqual({ dismissed: 5, badge: 0 });
    });

    it('defaults the badge to 0 when the server omits it', async () => {
        const client = {
            dismissAllPushes: vi.fn(async () => ({ data: { dismissed: 3 } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerDismissAllTool(server, client as unknown as HwipApiClient);

        const result = await run({});

        expect(parse(result)).toEqual({ dismissed: 3, badge: 0 });
    });

    it('formats an ApiError into a structured error result', async () => {
        const client = {
            dismissAllPushes: vi.fn(async () => {
                throw new ApiError('boom', 'UNKNOWN_ERROR', 500);
            }),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerDismissAllTool(server, client as unknown as HwipApiClient);

        const result = await run({});

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('UNKNOWN_ERROR');
    });
});
