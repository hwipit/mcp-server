import { describe, it, expect, vi } from 'vitest';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { captureResource } from '../test-helpers.js';
import { registerDevicesResource } from './devices.js';
import { ApiError, type HwipApiClient } from '../api-client.js';

// Resources never throw out to the client — a fetch failure is caught and
// serialized into the JSON body so the AI sees a readable { error } payload.

const parse = (r: ReadResourceResult) => JSON.parse((r.contents[0] as { text: string }).text);

describe('registerDevicesResource', () => {
    it('returns the device list as pretty-printed JSON', async () => {
        const devices = [{ deviceId: 'd1', isOnline: true }];
        const client = {
            listDevices: vi.fn(async () => ({ data: devices })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureResource();
        registerDevicesResource(server, client as unknown as HwipApiClient);

        const result = await run(new URL('hwip://devices'));

        expect(result.contents[0].uri).toBe('hwip://devices');
        expect(parse(result)).toEqual(devices);
    });

    it('catches an error into a JSON error payload', async () => {
        const client = {
            listDevices: vi.fn(async () => {
                throw new ApiError('nope', 'UNAUTHORIZED', 401);
            }),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureResource();
        registerDevicesResource(server, client as unknown as HwipApiClient);

        const result = await run(new URL('hwip://devices'));

        expect(parse(result)).toEqual({ error: 'nope' });
    });
});
