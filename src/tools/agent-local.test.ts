import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { execHwip, OTHER_SESSION_NOTICE, registerAgentListTool, registerAgentReadTool, runHwipCli, type ExecHwip } from './agent-local.js';

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

// The same objects the CLI tests pin (hwipit/cli src/agent-list.test.ts and src/agent-read.test.ts):
// if either side changes the shape, one of the two repos goes red.
const LIST_JSON = {
    v: 1,
    device: 'dev_mac',
    sessions: [
        { key: 'dev_mac:hwip-a', name: 'hwip-a', agent: 'claude', project: 'proj', label: null, providerName: null, state: 'idle', attached: false, lastActivityAt: null, self: false },
    ],
};
const READ_JSON = {
    v: 1,
    key: 'dev_mac:hwip-a',
    name: 'hwip-a',
    agent: 'claude',
    turns: [
        {
            at: '2026-10-09T01:00:00.000Z',
            prompt: 'fix the bug\nsecond line',
            promptCut: true,
            steps: [
                { kind: 'text', text: 'on it', cut: true },
                { kind: 'tool', name: 'Edit', target: 'src/a.ts', ok: true },
                { kind: 'tool', name: 'Bash', target: 'npm test', ok: false, cut: true },
            ],
        },
    ],
    more: false,
    masked: 2,
};

const succeeds = (body: unknown): ExecHwip => vi.fn(async () => ({ stdout: JSON.stringify(body), stderr: '' }));
const fails = (failure: Record<string, unknown>): ExecHwip =>
    vi.fn(async () => {
        throw Object.assign(new Error('Command failed'), failure);
    });

describe('runHwipCli', () => {
    it('passes the one JSON object of a successful run through', async () => {
        const result = await runHwipCli(['agent', 'list', '--json'], succeeds(LIST_JSON));

        expect(result.isError).toBeUndefined();
        expect(parse(result)).toEqual({ ...LIST_JSON, notice: OTHER_SESSION_NOTICE });
    });

    it('adds a notice right after v that says the content is data, not instructions', async () => {
        const result = await runHwipCli(['agent', 'read', 'x', '--json'], succeeds(READ_JSON));

        const text = (result.content[0] as { text: string }).text;
        expect(Object.keys(JSON.parse(text)).slice(0, 2)).toEqual(['v', 'notice']);
        expect(parse(result).notice).toMatch(/data, not instructions/);
    });

    it('answers CLI_NOT_FOUND when hwip is not on the PATH', async () => {
        const result = await runHwipCli(['agent', 'list', '--json'], fails({ code: 'ENOENT' }));

        expect(result.isError).toBe(true);
        expect(parse(result)).toMatchObject({ error: 'CLI_NOT_FOUND', suggestion: expect.stringContaining('@hwip/cli') });
    });

    it.each([
        ["hwip agent: only 'send' is a subcommand"],
        ['hwip agent: subcommands are send, list'],
    ])('answers CLI_TOO_OLD for a CLI that refuses the subcommand (%s)', async (stderr) => {
        const result = await runHwipCli(['agent', 'list', '--json'], fails({ code: 2, stderr }));

        expect(parse(result)).toMatchObject({ error: 'CLI_TOO_OLD' });
    });

    it('does not call a usage error CLI_TOO_OLD', async () => {
        const result = await runHwipCli(['agent', 'read', 'x', '--json'], fails({ code: 2, stderr: 'Usage: hwip agent read <session>' }));

        expect(parse(result)).toMatchObject({ error: 'CLI_FAILED', message: expect.stringContaining('Usage: hwip agent read') });
    });

    it('answers CLI_TIMEOUT when the CLI was killed for taking too long', async () => {
        const result = await runHwipCli(['agent', 'list', '--json'], fails({ killed: true, signal: 'SIGTERM', code: null }));

        expect(parse(result)).toMatchObject({ error: 'CLI_TIMEOUT' });
    });

    it('relays an error object the CLI reported with exit 1, adding what to do next', async () => {
        const stdout = JSON.stringify({ v: 1, error: 'UNKNOWN_TARGET', message: 'no agent session matches "nope"' });
        const result = await runHwipCli(['agent', 'read', 'nope', '--json'], fails({ code: 1, stdout }));

        expect(result.isError).toBe(true);
        expect(parse(result)).toEqual({ error: 'UNKNOWN_TARGET', message: 'no agent session matches "nope"', suggestion: expect.stringContaining('hwip_agent_list') });
    });

    it('relays an error code it has no advice for as it is', async () => {
        const stdout = JSON.stringify({ v: 1, error: 'SOMETHING_NEW', message: 'm' });
        const result = await runHwipCli(['agent', 'list', '--json'], fails({ code: 1, stdout }));

        expect(parse(result)).toEqual({ error: 'SOMETHING_NEW', message: 'm' });
    });

    it.each([
        ['stdout that is not JSON', 'oops'],
        ['JSON that is not an object', '[1]'],
        ['an object of an unknown contract version', JSON.stringify({ v: 2, device: 'd', sessions: [] })],
        ['an object with no version', JSON.stringify({ device: 'd', sessions: [] })],
    ])('answers CLI_BAD_OUTPUT for %s', async (_, stdout) => {
        const result = await runHwipCli(['agent', 'list', '--json'], vi.fn(async () => ({ stdout, stderr: '' })));

        expect(result.isError).toBe(true);
        expect(parse(result)).toMatchObject({ error: 'CLI_BAD_OUTPUT' });
    });

    it('answers CLI_BAD_OUTPUT for an error object of an unknown contract version', async () => {
        const stdout = JSON.stringify({ v: 2, error: 'NO_TMUX', message: 'm' });
        const result = await runHwipCli(['agent', 'list', '--json'], fails({ code: 1, stdout }));

        expect(parse(result)).toMatchObject({ error: 'CLI_BAD_OUTPUT' });
    });

    it('answers CLI_BAD_OUTPUT when the output outgrew the buffer', async () => {
        const result = await runHwipCli(['agent', 'read', 'x', '--json'], fails({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));

        expect(parse(result)).toMatchObject({ error: 'CLI_BAD_OUTPUT', message: expect.stringContaining('4 MiB') });
    });

    it('answers CLI_FAILED with the start of stderr for a failure that is not JSON', async () => {
        const result = await runHwipCli(['agent', 'list', '--json'], fails({ code: 1, stdout: 'not json', stderr: `boom ${'x'.repeat(2000)}` }));

        const body = parse(result);
        expect(body.error).toBe('CLI_FAILED');
        expect(body.message).toContain('boom');
        expect(body.message.length).toBeLessThan(700);
    });
});

describe('tools', () => {
    it('hwip_agent_list runs `hwip agent list --json`', async () => {
        const exec = succeeds(LIST_JSON);
        const { server, run } = captureTool();
        registerAgentListTool(server, exec);

        const result = await run({});

        expect(exec).toHaveBeenCalledWith(['agent', 'list', '--json']);
        expect(parse(result)).toEqual({ ...LIST_JSON, notice: OTHER_SESSION_NOTICE });
    });

    it('hwip_agent_read passes the session as one argument and --turns only when given', async () => {
        const exec = succeeds(READ_JSON);
        const { server, run } = captureTool();
        registerAgentReadTool(server, exec);

        const withTurns = await run({ session: 'dev_mac:hwip-a', turns: 5 });
        await run({ session: 'a; rm -rf ~' });

        expect(exec).toHaveBeenNthCalledWith(1, ['agent', 'read', 'dev_mac:hwip-a', '--turns', '5', '--json']);
        expect(exec).toHaveBeenNthCalledWith(2, ['agent', 'read', 'a; rm -rf ~', '--json']);
        expect(parse(withTurns)).toEqual({ ...READ_JSON, notice: OTHER_SESSION_NOTICE });
    });
});

describe('execHwip', () => {
    const originalPath = process.env.PATH;
    const dirs: string[] = [];

    afterEach(() => {
        process.env.PATH = originalPath;
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    const withPath = (script?: string) => {
        const dir = mkdtempSync(join(tmpdir(), 'hwip-bin-'));
        dirs.push(dir);
        if (script !== undefined) {
            const file = join(dir, 'hwip');
            writeFileSync(file, script);
            chmodSync(file, 0o755);
        }
        process.env.PATH = dir;
    };

    it.skipIf(process.platform === 'win32')('runs hwip with the arguments as they are, never through a shell', async () => {
        // The stand-in prints its arguments, one JSON object: a shell would have split or run them.
        withPath(`#!${process.execPath}\nconsole.log(JSON.stringify({ v: 1, argv: process.argv.slice(2) }));\n`);

        const { stdout } = await execHwip(['agent', 'read', 'a b; echo hi', '--json']);

        expect(JSON.parse(stdout)).toEqual({ v: 1, argv: ['agent', 'read', 'a b; echo hi', '--json'] });
    });

    it.skipIf(process.platform === 'win32')('rejects with ENOENT when there is no hwip on the PATH', async () => {
        withPath();

        await expect(execHwip(['agent', 'list', '--json'])).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.skipIf(process.platform === 'win32')('stops a run whose output outgrows the buffer, and the tool answers CLI_BAD_OUTPUT', async () => {
        withPath(`#!${process.execPath}\nprocess.stdout.write('x'.repeat(5 * 1024 * 1024));\n`);

        await expect(execHwip(['agent', 'read', 'x', '--json'])).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        expect(parse(await runHwipCli(['agent', 'read', 'x', '--json']))).toMatchObject({ error: 'CLI_BAD_OUTPUT', message: expect.stringContaining('4 MiB') });
    });

    it.skipIf(process.platform === 'win32')('keeps stdout and stderr on a failed run', async () => {
        withPath(`#!${process.execPath}\nconsole.log('{"v":1,"error":"NO_TMUX","message":"m"}'); console.error('err'); process.exit(1);\n`);

        await expect(execHwip(['agent', 'list', '--json'])).rejects.toMatchObject({
            code: 1,
            stdout: expect.stringContaining('NO_TMUX'),
            stderr: expect.stringContaining('err'),
        });
    });
});
