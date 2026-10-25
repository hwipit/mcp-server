import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hostname } from 'os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { registerAgentSendTool } from './agent-send.js';
import { ApiError, type HwipApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import type { DeviceRecord } from '../types.js';
import { sealedCommand } from '../command-seal.js';
import { holdKeyChanges } from '../key-changes.js';

// The decision to seal, and the envelope, are tested in command-seal.test.ts: here only what the tool does with the answer.
vi.mock('../command-seal.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../command-seal.js')>()),
    sealedCommand: vi.fn(),
}));

const FIELDS = { body: 'CIPHERTEXT', senderPublicKey: 'SENDER_KEY', deviceKeyMap: { dev_linux: 'SLOT' } };

beforeEach(() => {
    vi.mocked(sealedCommand).mockReset();
    vi.mocked(sealedCommand).mockResolvedValue({ kind: 'sealed', fields: FIELDS });
});

/** The text that went into the seal: header and message. */
const sealedText = () => vi.mocked(sealedCommand).mock.calls[0][0].message;

const config: McpServerConfig = {
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    deviceId: 'dev_default',
    agentDeviceId: 'dev_mac',
    agentSessionName: 'hwip-proj',
};

const devices: DeviceRecord[] = [
    {
        deviceId: 'dev_mac',
        nickname: 'takPC',
        agentSessions: [{ name: 'hwip-proj' }, { name: 'hwip-brain' }],
        agentSessionAliases: { 'hwip-proj': 'deploy' },
    },
    { deviceId: 'dev_linux', nickname: 'test-machine', agentSessions: [{ name: 'hwip-brain' }] },
];

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

const setup = (over: Partial<McpServerConfig> = {}, list: DeviceRecord[] = devices) => {
    const client = {
        listDevices: vi.fn(async () => ({ data: list })),
        registerDeviceKey: vi.fn(async () => ({ data: list[0]! })),
        sendPush: vi.fn(async (_params: Parameters<HwipApiClient['sendPush']>[0]) => ({ data: { pushId: 'push_1' } })),
    } satisfies Pick<HwipApiClient, 'listDevices' | 'registerDeviceKey' | 'sendPush'>;
    const { server, run } = captureTool();
    registerAgentSendTool(server, client, { ...config, ...over });
    return { client, run };
};

describe('hwip_agent_send', () => {
    it('ends the result with a Note for a device whose key changed', async () => {
        holdKeyChanges([{ deviceId: 'dev_phone', at: '2026-10-13T09:00:00.000Z', name: 'iPhone' }]);
        const { run } = setup();

        const result = await run({ target: 'dev_linux:hwip-brain', message: 'hi' });

        expect(parse(result).sent).toBe(true);
        expect(result.content[1]).toEqual({ type: 'text', text: 'Note: iPhone changed its encryption key — the new key is trusted. If you did not expect this, check it with: hwip trust' });
    });

    it('types the message into the target session, headed by who sent it and where to reply', async () => {
        const { client, run } = setup();

        const result = await run({ target: 'dev_linux:hwip-brain', message: '빌드 로그 확인해줘' });

        expect(sealedText()).toBe('[from deploy@takPC · reply: dev_mac:hwip-proj] 빌드 로그 확인해줘');
        expect(client.sendPush).toHaveBeenCalledWith({
            type: 'agent.command',
            targetDeviceId: 'dev_linux',
            agentSessionName: 'hwip-brain',
            isEncrypted: true,
            ...FIELDS,
        });
        expect(parse(result)).toEqual({ sent: true, target: 'dev_linux:hwip-brain', pushId: 'push_1' });
    });

    // agentDeviceId would file the push under a chat that is not the target's.
    it('sends no agentDeviceId', async () => {
        const { client, run } = setup();

        await run({ target: 'dev_linux:hwip-brain', message: 'hi' });

        expect(client.sendPush.mock.calls[0][0]).not.toHaveProperty('agentDeviceId');
    });

    it('names the machine by its hostname when the device has no nickname', async () => {
        const { client, run } = setup({}, [{ ...devices[0], nickname: undefined }, devices[1]]);

        await run({ target: 'dev_linux:hwip-brain', message: 'hi' });

        expect(sealedText()).toBe(
            `[from deploy@${hostname()} · reply: dev_mac:hwip-proj] hi`,
        );
    });

    it('drops the reply key outside a tmux session — there is nothing to reply to', async () => {
        const { client, run } = setup({ agentDeviceId: undefined, agentSessionName: undefined });

        await run({ target: 'dev_linux:hwip-brain', message: 'hi' });

        expect(sealedText()).toBe(`[from proj@${hostname()}] hi`);
    });

    it('refuses to send to itself', async () => {
        const { client, run } = setup();

        const result = await run({ target: 'deploy', message: 'hi' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('SELF_TARGET');
        expect(client.sendPush).not.toHaveBeenCalled();
    });

    it('refuses its own exact key', async () => {
        const { client, run } = setup();

        const result = await run({ target: 'dev_mac:hwip-proj', message: 'hi' });

        expect(parse(result).error).toBe('SELF_TARGET');
        expect(client.sendPush).not.toHaveBeenCalled();
    });

    it('reports an unknown or offline target as a tool error, and sends nothing', async () => {
        const away = devices.map((d) => (d.deviceId === 'dev_linux' ? { ...d, isOnline: false } : d));
        const { client, run } = setup({}, away);

        const unknown = await run({ target: 'nothing-like-this', message: 'hi' });
        const offline = await run({ target: 'dev_linux:hwip-brain', message: 'hi' });

        expect(unknown.isError && parse(unknown).error).toBe('UNKNOWN_TARGET');
        expect(offline.isError && parse(offline).error).toBe('TARGET_OFFLINE');
        expect(client.sendPush).not.toHaveBeenCalled();
    });

    it('returns the candidate keys when the name is ambiguous, and sends nothing', async () => {
        const { client, run } = setup();

        const result = await run({ target: 'hwip-brain', message: 'hi' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('AMBIGUOUS_TARGET');
        expect(parse(result).message).toContain('dev_linux:hwip-brain');
        expect(client.sendPush).not.toHaveBeenCalled();
    });

    it('reports the daily push quota as a tool error', async () => {
        const { client, run } = setup();
        client.sendPush.mockRejectedValueOnce(new ApiError('Daily push limit reached', 'QUOTA_EXCEEDED', 429));

        const result = await run({ target: 'dev_linux:hwip-brain', message: 'hi' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('QUOTA_EXCEEDED');
    });

    it('signs with the tmux name when the session has no alias', async () => {
        const { client, run } = setup({}, [{ ...devices[0], agentSessionAliases: undefined }, devices[1]]);

        await run({ target: 'dev_linux:hwip-brain', message: 'hi' });

        expect(sealedText()).toBe('[from hwip-proj@takPC · reply: dev_mac:hwip-proj] hi');
    });

    // A tmux session the listener does not report has no key anyone could answer on.
    it('offers no reply key from a session the listener does not report', async () => {
        const { client, run } = setup({ agentSessionName: 'scratch' });

        await run({ target: 'dev_linux:hwip-brain', message: 'hi' });

        expect(sealedText()).toBe('[from scratch@takPC] hi');
    });

    // A pi subagent pane names itself `<#S>.<pane>`; replies only resolve to top-level sessions.
    it('offers no reply key from a subagent', async () => {
        const withSubagent = [
            { ...devices[0], agentSessions: [...(devices[0].agentSessions ?? []), { name: 'hwip-proj.2', parentName: 'hwip-proj' }] },
            devices[1],
        ];
        const { client, run } = setup({ agentSessionName: 'hwip-proj.2' }, withSubagent);

        await run({ target: 'dev_linux:hwip-brain', message: 'hi' });

        expect(sealedText()).toBe('[from hwip-proj.2@takPC] hi');
    });

    // An agent started inside a `hwip sh` session: the shell is never a target,
    // so a reply key pointing at it would not resolve.
    it('offers no reply key from a shell session', async () => {
        const withShell = [
            { ...devices[0], agentSessions: [...(devices[0].agentSessions ?? []), { name: 'hwip-proj-sh', agentKind: 'shell' }] },
            devices[1],
        ];
        const { client, run } = setup({ agentSessionName: 'hwip-proj-sh' }, withShell);

        await run({ target: 'dev_linux:hwip-brain', message: 'hi' });

        expect(sealedText()).toBe('[from hwip-proj-sh@takPC] hi');
    });

    // The same project on two PCs: from one of them, its name means the other.
    it('reads a name it shares with the target as the other machine’s session', async () => {
        const { client, run } = setup({ agentSessionName: 'hwip-brain' });

        const result = await run({ target: 'hwip-brain', message: 'hi' });

        expect(parse(result).target).toBe('dev_linux:hwip-brain');
        expect(client.sendPush).toHaveBeenCalledTimes(1);
    });
    describe('sealing', () => {
        it('sends only the envelope: the header and the message are inside it, and the push still names the target session', async () => {
            const { client, run } = setup();

            const result = await run({ target: 'dev_linux:hwip-brain', message: 'rotate the key' });

            expect(sealedCommand).toHaveBeenCalledWith(
                { targetDeviceId: 'dev_linux', session: 'hwip-brain', message: '[from deploy@takPC · reply: dev_mac:hwip-proj] rotate the key' },
                expect.anything(),
            );
            expect(client.sendPush).toHaveBeenCalledWith({
                type: 'agent.command',
                targetDeviceId: 'dev_linux',
                agentSessionName: 'hwip-brain',
                isEncrypted: true,
                ...FIELDS,
            });
            expect(JSON.stringify(client.sendPush.mock.calls)).not.toContain('rotate the key');
            expect(parse(result)).toEqual({ sent: true, target: 'dev_linux:hwip-brain', pushId: 'push_1' });
        });

        it('sends nothing and says why when sealing is refused — never a plaintext fallback', async () => {
            vi.mocked(sealedCommand).mockResolvedValue({ kind: 'refused', cause: 'target-unlisted' });
            const { client, run } = setup();

            const result = await run({ target: 'dev_linux:hwip-brain', message: 'rotate the key' });

            expect(result.isError).toBe(true);
            expect(parse(result).error).toBe('SEALED_SEND_FAILED');
            expect(parse(result).message).toContain('not in the account\'s device list');
            expect(JSON.stringify(parse(result))).not.toContain('rotate the key');
            expect(client.sendPush).not.toHaveBeenCalled();
        });

        it('sends nothing, and names why, when this machine\'s key could not be registered', async () => {
            vi.mocked(sealedCommand).mockResolvedValue({ kind: 'refused', cause: 'self-unlisted', why: 'replace-forbidden' });
            const { client, run } = setup();

            const result = await run({ target: 'dev_linux:hwip-brain', message: 'rotate the key' });

            expect(result.isError).toBe(true);
            expect(parse(result).message).toBe(
                'sealed send: could not register this machine\'s key in the account\'s device list (the account lists another key for it, and only an API key with device:write and push:read may replace it); the message was not sent',
            );
            expect(client.sendPush).not.toHaveBeenCalled();
        });

        it('does not decide anything about a target that did not resolve', async () => {
            const { client, run } = setup();

            await run({ target: 'nothing-like-this', message: 'hi' });

            expect(sealedCommand).not.toHaveBeenCalled();
            expect(client.sendPush).not.toHaveBeenCalled();
        });
    });
});
