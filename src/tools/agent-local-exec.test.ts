import { beforeEach, describe, expect, it, vi } from 'vitest';

// What `execHwip` hands to `execFile`. The real timeout is 15 s, too long to wait out in a test, so the options are
// read off the call; the buffer limit is also run for real in agent-local.test.ts.
const execFile = vi.fn();
vi.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFile(...args) }));

const { execHwip } = await import('./agent-local.js');

describe('execHwip: how it runs hwip', () => {
    beforeEach(() => {
        execFile.mockReset();
        execFile.mockImplementation((_file, _args, _options, done: (err: null, stdout: string, stderr: string) => void) => done(null, '{}', ''));
    });

    it('runs the hwip binary with the arguments as an array, a 15 s timeout and a 4 MiB buffer', async () => {
        await execHwip(['agent', 'list', '--json']);

        expect(execFile).toHaveBeenCalledTimes(1);
        const [file, args, options] = execFile.mock.calls[0]!;
        expect(file).toBe('hwip');
        expect(args).toEqual(['agent', 'list', '--json']);
        expect(options).toMatchObject({ timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    });

    it('does not run through a shell', async () => {
        await execHwip(['agent', 'read', 'a; rm -rf ~', '--json']);

        expect(execFile.mock.calls[0]![2]).not.toHaveProperty('shell');
    });

    it('rejects with the error carrying what the child printed', async () => {
        execFile.mockImplementation((_f, _a, _o, done: (err: Error, stdout: string, stderr: string) => void) => done(new Error('boom'), 'out', 'err'));

        await expect(execHwip(['agent', 'list', '--json'])).rejects.toMatchObject({ message: 'boom', stdout: 'out', stderr: 'err' });
    });
});
