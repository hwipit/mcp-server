import { afterEach, describe, expect, it, vi } from 'vitest';

// M18: start-up shells out to cksum, ioreg, tmux and ps. None had a timeout, so
// one wedged tool (a hung tmux server, a stalled ioreg) held the MCP server's
// start forever — and `projectHash` re-ran cksum on every remote-state touch
// for a value that cannot change within a process.

const io = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock('child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('child_process')>()),
    execFileSync: (...args: unknown[]) => io.execFileSync(...args),
}));

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const onDarwin = () => Object.defineProperty(process, 'platform', { value: 'darwin' });

afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
});

const optionsOf = (call: unknown[]): { timeout?: number } =>
    call.find((arg) => typeof arg === 'object' && arg !== null && !Array.isArray(arg)) as { timeout?: number };

describe('shell-outs at start', () => {
    it('bounds cksum with a timeout', async () => {
        io.execFileSync.mockReturnValue('1234567 8\n');
        const { projectHash } = await import('./config.js');
        projectHash('/some/dir');
        expect(optionsOf(io.execFileSync.mock.calls[0]).timeout).toBeGreaterThan(0);
    });

    it('bounds ioreg with a timeout', async () => {
        onDarwin();
        io.execFileSync.mockReturnValue('  "IOPlatformUUID" = "HWIP-TEST-MACHINE-ID-0001"\n');
        const { listenerDeviceId } = await import('./config.js');
        listenerDeviceId();
        const call = io.execFileSync.mock.calls.find((c) => c[0] === '/usr/sbin/ioreg');
        expect(call).toBeDefined();
        expect(optionsOf(call!).timeout).toBeGreaterThan(0);
    });

    // /usr/sbin is not on every PATH (an IDE or hook environment); a failed lookup would seed the
    // device id from the hostname instead and unthread hwip_ask from the agent chat.
    it('runs ioreg by its absolute path, never through PATH', async () => {
        onDarwin();
        io.execFileSync.mockReturnValue('  "IOPlatformUUID" = "HWIP-TEST-MACHINE-ID-0001"\n');
        const { listenerDeviceId } = await import('./config.js');
        listenerDeviceId();
        expect(io.execFileSync).toHaveBeenCalledWith('/usr/sbin/ioreg', expect.anything(), expect.anything());
        expect(io.execFileSync.mock.calls.some((c) => c[0] === 'ioreg')).toBe(false);
    });

    it('bounds tmux and ps with a timeout', async () => {
        vi.stubEnv('TMUX', '');
        io.execFileSync.mockImplementation((cmd: string) => (cmd === 'tmux' ? '1000 hwip-x\n' : '1\n'));
        const { detectTmuxSessionName } = await import('./config.js');
        detectTmuxSessionName();
        const cmds = io.execFileSync.mock.calls.map((c) => c[0]);
        expect(cmds).toContain('tmux');
        for (const call of io.execFileSync.mock.calls) {
            expect(optionsOf(call).timeout, `${call[0]} has no timeout`).toBeGreaterThan(0);
        }
    });

    it('treats a timed-out command like a missing one', async () => {
        io.execFileSync.mockImplementation(() => {
            throw Object.assign(new Error('spawnSync cksum ETIMEDOUT'), { code: 'ETIMEDOUT' });
        });
        const { projectHash } = await import('./config.js');
        expect(projectHash('/some/dir')).toBeNull();
    });
});

describe('results that cannot change within a process', () => {
    it('runs cksum once per directory', async () => {
        io.execFileSync.mockReturnValue('1234567 8\n');
        const { projectHash } = await import('./config.js');
        expect(projectHash('/a')).toBe('1234567');
        expect(projectHash('/a')).toBe('1234567');
        expect(io.execFileSync).toHaveBeenCalledTimes(1);
        projectHash('/b');
        expect(io.execFileSync).toHaveBeenCalledTimes(2);
    });

    it('does not remember a failed cksum', async () => {
        io.execFileSync.mockImplementationOnce(() => { throw new Error('ETIMEDOUT'); });
        io.execFileSync.mockReturnValue('1234567 8\n');
        const { projectHash } = await import('./config.js');
        expect(projectHash('/a')).toBeNull();
        expect(projectHash('/a')).toBe('1234567');
    });
});
