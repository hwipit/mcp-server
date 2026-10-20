import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { registerTitleTool } from './title.js';
import { ApiError, type HwipApiClient } from '../api-client.js';
import { createServer } from '../server.js';
import type { McpServerConfig } from '../config.js';

// An agent without a title of its own (Codex, Cursor, …) names its session
// through this tool, so the phone shows what the session was asked to do. The
// installer turns it on per agent with HWIP_AUTONAME=1; agents that title
// themselves (Claude Code, opencode) never see it, so they are not told twice.

const config: McpServerConfig = {
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    agentDeviceId: 'dev_listener_abc12345',
    agentSessionName: 'hwip-proj',
};

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

const clients: Client[] = [];
afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
});

const connect = async (autoName: boolean | undefined) => {
    const server = createServer({ ...config, autoName });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    clients.push(client);
    return client;
};

describe('createServer with auto names', () => {
    it('offers hwip_session_title and tells the agent when to call it, only when turned on', async () => {
        const on = await connect(true);
        expect((await on.listTools()).tools.map((t) => t.name)).toContain('hwip_session_title');
        expect(on.getInstructions()).toContain('hwip_session_title');
        expect(on.getInstructions()).toContain('Do not mention it to the user');

        for (const autoName of [false, undefined]) {
            const off = await connect(autoName);
            expect((await off.listTools()).tools.map((t) => t.name)).not.toContain('hwip_session_title');
            expect(off.getInstructions()).not.toContain('hwip_session_title');
        }
    });

    // Instructions load into every turn of the agent's context.
    it('keeps the instructions short with the naming line in', async () => {
        const instructions = (await connect(true)).getInstructions() ?? '';
        expect(instructions).toContain('hwip_ask');
        expect(instructions.length).toBeLessThanOrEqual(600);
    });
});

describe('registerTitleTool', () => {
    const register = (client: Partial<HwipApiClient>, cfg: McpServerConfig = config) => {
        const { server, run } = captureTool();
        registerTitleTool(server, client as unknown as HwipApiClient, cfg); // test double: the tool calls one client method
        return run;
    };

    it('titles the current session through the auto-name route, not the rename', async () => {
        const client = {
            setAgentSessionAutoName: vi.fn(async () => ({ data: { deviceId: 'dev_listener_abc12345' } })),
            renameAgentSession: vi.fn(),
        } satisfies Partial<HwipApiClient>;

        const result = await register(client)({ title: 'Downloads 폴더 정리' });

        expect(client.setAgentSessionAutoName).toHaveBeenCalledWith('dev_listener_abc12345', 'hwip-proj', 'Downloads 폴더 정리');
        expect(client.renameAgentSession).not.toHaveBeenCalled();
        expect(parse(result)).toEqual({ titled: true, session: 'hwip-proj', title: 'Downloads 폴더 정리' });
    });

    it('reports a no-op when no agent session is known', async () => {
        const client = { setAgentSessionAutoName: vi.fn() } satisfies Partial<HwipApiClient>;

        const result = await register(client, { ...config, agentSessionName: undefined })({ title: 'Fix login' });

        expect(client.setAgentSessionAutoName).not.toHaveBeenCalled();
        expect(parse(result).titled).toBe(false);
        expect(parse(result).reason).toMatch(/hwip listener/);
    });

    // A title the server will not take (a session it has not seen reported
    // yet) is the agent's business alone — nothing to fail the turn over.
    it('answers titled:false with the reason when the server refuses the title', async () => {
        const client = {
            setAgentSessionAutoName: vi.fn(async () => {
                throw new ApiError("No agent session named 'hwip-proj' on device dev_listener_abc12345", 'VALIDATION_ERROR', 400);
            }),
        } satisfies Partial<HwipApiClient>;

        const result = await register(client)({ title: 'Fix login' });

        expect(result.isError).toBeFalsy();
        expect(parse(result)).toEqual({ titled: false, reason: "No agent session named 'hwip-proj' on device dev_listener_abc12345" });
    });

    // An API not yet carrying the route answers 404, and so does a device the
    // account no longer has.
    it('answers titled:false when the server has no such route or device', async () => {
        const client = {
            setAgentSessionAutoName: vi.fn(async () => {
                throw new ApiError('Not found', 'NOT_FOUND', 404);
            }),
        } satisfies Partial<HwipApiClient>;

        const result = await register(client)({ title: 'Fix login' });

        expect(result.isError).toBeFalsy();
        expect(parse(result)).toEqual({ titled: false, reason: 'Not found' });
    });

    it('formats any other failure as a tool error', async () => {
        const client = {
            setAgentSessionAutoName: vi.fn(async () => {
                throw new ApiError('nope', 'FORBIDDEN', 403);
            }),
        } satisfies Partial<HwipApiClient>;

        const result = await register(client)({ title: 'Fix login' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('FORBIDDEN');
    });
});

describe('createServer — title arguments', () => {
    it.each([
        ['an empty title', '   '],
        ['a title over 40 characters', 'x'.repeat(41)],
    ])('refuses %s before calling the server', async (_label, title) => {
        const client = await connect(true);

        const result = await client.callTool({ name: 'hwip_session_title', arguments: { title } });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('Invalid arguments');
    });
});
