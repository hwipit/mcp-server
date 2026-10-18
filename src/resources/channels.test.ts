import { describe, it, expect, vi } from 'vitest';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { captureResource } from '../test-helpers.js';
import { registerChannelsResource } from './channels.js';
import { ApiError, type HwipApiClient } from '../api-client.js';

const parse = (r: ReadResourceResult) => JSON.parse((r.contents[0] as { text: string }).text);

describe('registerChannelsResource', () => {
    it('returns the channel list as pretty-printed JSON', async () => {
        const channels = [
            { channelId: 'ch_1', tag: 'team', name: 'Team', ownerId: 'u1', subscriberCount: 3, isPublic: false },
        ];
        const client = {
            listChannels: vi.fn(async () => ({ data: channels })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureResource();
        registerChannelsResource(server, client as unknown as HwipApiClient);

        const result = await run(new URL('hwip://channels'));

        expect(result.contents[0].uri).toBe('hwip://channels');
        expect(parse(result)).toEqual(channels);
    });

    it('catches an error into a JSON error payload', async () => {
        const client = {
            listChannels: vi.fn(async () => {
                throw new ApiError('forbidden', 'FORBIDDEN', 403);
            }),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureResource();
        registerChannelsResource(server, client as unknown as HwipApiClient);

        const result = await run(new URL('hwip://channels'));

        expect(parse(result)).toEqual({ error: 'forbidden' });
    });
});
