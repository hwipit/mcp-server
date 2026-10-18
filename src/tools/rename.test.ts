import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { registerRenameTool } from './rename.js';
import { ApiError, type HwipApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';

const config: McpServerConfig = {
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    sessionId: 'sess_1',
    deviceId: 'dev_default',
    agentDeviceId: 'dev_listener_abc12345',
    agentSessionName: 'hwip-proj',
};

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe('registerRenameTool', () => {
    it('renames the current session using config agentDeviceId + agentSessionName', async () => {
        const client = {
            renameAgentSession: vi.fn(async () => ({ data: { deviceId: 'dev_listener_abc12345' } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerRenameTool(server, client as unknown as HwipApiClient, config);

        const result = await run({ alias: 'Prod deploy' });

        expect(client.renameAgentSession).toHaveBeenCalledWith('dev_listener_abc12345', 'hwip-proj', 'Prod deploy');
        expect(parse(result)).toEqual({ renamed: true, session: 'hwip-proj', alias: 'Prod deploy' });
    });

    it('reports a no-op when no active agent session is known', async () => {
        const client = {
            renameAgentSession: vi.fn(),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerRenameTool(server, client as unknown as HwipApiClient, { ...config, agentSessionName: undefined });

        const result = await run({ alias: 'X' });

        expect(client.renameAgentSession).not.toHaveBeenCalled();
        expect(parse(result).renamed).toBe(false);
    });

    it('formats an ApiError into a structured error result', async () => {
        const client = {
            renameAgentSession: vi.fn(async () => {
                throw new ApiError('nope', 'FORBIDDEN', 403);
            }),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerRenameTool(server, client as unknown as HwipApiClient, config);

        const result = await run({ alias: 'X' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('FORBIDDEN');
    });
});
