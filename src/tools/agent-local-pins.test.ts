import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { registerAgentListTool, runHwipCli, type ExecHwip } from './agent-local.js';

// Pins for the error path and the `self` label of the agent tools (t96 note #9).

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);
const fails = (failure: Record<string, unknown>): ExecHwip =>
    vi.fn(async () => {
        throw Object.assign(new Error('Command failed'), failure);
    });

describe('runHwipCli failures', () => {
    it('shows exactly 500 characters of stderr, no more', async () => {
        const body = parse(await runHwipCli(['agent', 'list', '--json'], fails({ code: 1, stdout: 'x', stderr: 'a'.repeat(600) })));
        expect(body.message).toContain(`: ${'a'.repeat(500)}`);
        expect(body.message).not.toContain('a'.repeat(501));
    });

    it('shows a stderr of exactly 500 characters whole', async () => {
        const body = parse(await runHwipCli(['agent', 'list', '--json'], fails({ code: 1, stdout: 'x', stderr: `${'b'.repeat(499)}c` })));
        expect(body.message.endsWith(`${'b'.repeat(499)}c`)).toBe(true);
    });

    it('names the exit code and ends with a full stop when stderr is blank', async () => {
        const body = parse(await runHwipCli(['agent', 'list', '--json'], fails({ code: 3, stdout: '', stderr: ' \n ' })));
        expect(body).toMatchObject({ error: 'CLI_FAILED', message: '`hwip agent list --json` failed (3).' });
    });

    it('says "no exit code" when the failure has none', async () => {
        const body = parse(await runHwipCli(['agent', 'list', '--json'], fails({ stdout: '', stderr: '' })));
        expect(body.message).toBe('`hwip agent list --json` failed (no exit code).');
    });

    it('states the 15-second limit in CLI_TIMEOUT', async () => {
        const body = parse(await runHwipCli(['agent', 'list', '--json'], fails({ killed: true })));
        expect(body).toMatchObject({ error: 'CLI_TIMEOUT', message: expect.stringContaining('within 15 seconds') });
    });

    it('answers CLI_NOT_FOUND for ENOENT, with the install hint', async () => {
        const body = parse(await runHwipCli(['agent', 'list', '--json'], fails({ code: 'ENOENT' })));
        expect(body).toMatchObject({ error: 'CLI_NOT_FOUND', suggestion: expect.stringContaining('npm install -g @hwip/cli') });
    });

    it('treats exit 1 with a JSON error as the CLI\'s own answer, but a non-string error as a plain failure', async () => {
        const own = parse(await runHwipCli(['agent', 'list', '--json'], fails({ code: 1, stdout: JSON.stringify({ v: 1, error: 'NO_TMUX', message: 'no server' }) })));
        expect(own).toMatchObject({ error: 'NO_TMUX', message: 'no server' });
        const odd = parse(await runHwipCli(['agent', 'list', '--json'], fails({ code: 1, stdout: JSON.stringify({ v: 1, error: 5 }) })));
        expect(odd.error).toBe('CLI_FAILED');
    });

    it('does not take a JSON error on any other exit code for the CLI\'s own answer', async () => {
        const body = parse(await runHwipCli(['agent', 'list', '--json'], fails({ code: 4, stdout: JSON.stringify({ v: 1, error: 'NO_TMUX', message: 'no server' }) })));
        expect(body.error).toBe('CLI_FAILED');
    });
});

describe('hwip_agent_list all: which row is self', () => {
    const devices = [{ deviceId: 'dev_mac', agentSessions: [{ name: 'hwip-proj', project: 'proj', agentKind: 'claude' }] }];
    const selves = async (config: { agentDeviceId?: string; agentSessionName?: string }) => {
        const { server, run } = captureTool();
        registerAgentListTool(server, vi.fn(), { listDevices: vi.fn(async () => ({ data: devices })) }, config);
        return parse(await run({ all: true })).sessions.map((s: { self: boolean }) => s.self);
    };

    it('marks the row when both the device and the session name are known', async () => {
        expect(await selves({ agentDeviceId: 'dev_mac', agentSessionName: 'hwip-proj' })).toEqual([true]);
    });

    it('marks nothing with only a device id', async () => {
        expect(await selves({ agentDeviceId: 'dev_mac' })).toEqual([false]);
    });

    it('marks nothing with only a session name', async () => {
        expect(await selves({ agentSessionName: 'hwip-proj' })).toEqual([false]);
    });
});
