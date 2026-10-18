import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { registerListTool } from './list.js';
import { ApiError, type HwipApiClient } from '../api-client.js';

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe('registerListTool', () => {
    it('summarizes recent pushes and truncates the body to 100 chars', async () => {
        const longBody = 'b'.repeat(150);
        const client = {
            listPushes: vi.fn(async () => ({
                data: [{ pushId: 'p1', type: 'note', title: 'T', body: longBody, createdAt: '2026-01-01' }],
                pagination: { hasMore: true },
            })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerListTool(server, client as unknown as HwipApiClient);

        const result = await run({ limit: 5 });

        expect(client.listPushes).toHaveBeenCalledWith({ limit: 5, type: undefined });
        const body = parse(result);
        expect(body.total).toBe(1);
        expect(body.hasMore).toBe(true);
        expect(body.pushes[0]).toEqual({
            pushId: 'p1',
            type: 'note',
            title: 'T',
            body: 'b'.repeat(100),
            createdAt: '2026-01-01',
        });
    });

    it('marks an encrypted push and leaves its sealed body out', async () => {
        const client = {
            listPushes: vi.fn(async () => ({
                data: [{ pushId: 'p1', type: 'note', title: '', body: '{"ciphertext":"x","iv":"y"}', isEncrypted: true, createdAt: '2026-01-01' }],
                pagination: { hasMore: false },
            })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerListTool(server, client as unknown as HwipApiClient);

        const body = parse(await run({ limit: 5 }));
        expect(body.pushes[0]).toEqual({ pushId: 'p1', type: 'note', encrypted: true, createdAt: '2026-01-01' });
    });

    it('passes a type filter through to the api-client', async () => {
        const client = {
            listPushes: vi.fn(async () => ({ data: [], pagination: { hasMore: false } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerListTool(server, client as unknown as HwipApiClient);

        const result = await run({ limit: 10, type: 'file' });

        expect(client.listPushes).toHaveBeenCalledWith({ limit: 10, type: 'file' });
        expect(parse(result)).toEqual({ pushes: [], total: 0, hasMore: false });
    });

    it('formats an ApiError into a structured error result', async () => {
        const client = {
            listPushes: vi.fn(async () => {
                throw new ApiError('nope', 'UNAUTHORIZED', 401);
            }),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerListTool(server, client as unknown as HwipApiClient);

        const result = await run({ limit: 5 });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('UNAUTHORIZED');
    });
});
