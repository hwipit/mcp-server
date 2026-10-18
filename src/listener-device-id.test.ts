import { afterEach, describe, expect, it, vi } from 'vitest';

// Cross-repo contract: `listenerDeviceId()` MUST equal what cli
// `computeListenerDeviceId()` produces for the same machine, otherwise a
// `hwip_ask` hook lands in the Streams feed but never threads into the agent
// chat (the bug this test guards). It once regressed because this repo seeded
// the id from the hostname while cli seeded from the platform machine id.
//
// The golden constants are hardcoded so a change to EITHER the seed source or
// the hash breaks the test. cli/src/listener.test.ts asserts the same
// `dev_listener_ffd86de0` for the same machine seed.
const GOLDEN_MACHINE_ID = 'dev_listener_ffd86de0'; // dev_listener_<sha8('HWIP-TEST-MACHINE-ID-0001')>
const GOLDEN_HOSTNAME = 'dev_listener_e82c9f59'; //   dev_listener_<sha8('hwip-test-host')>

const io = vi.hoisted(() => ({
    execFileSync: vi.fn(),
    readFileSync: vi.fn(),
    hostname: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('child_process')>()),
    execFileSync: (...args: unknown[]) => io.execFileSync(...args),
}));
vi.mock('fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('fs')>()),
    readFileSync: (...args: unknown[]) => io.readFileSync(...args),
}));
vi.mock('os', async (importOriginal) => ({
    ...(await importOriginal<typeof import('os')>()),
    hostname: () => io.hostname(),
}));

afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
});

describe('listenerDeviceId (must match cli computeListenerDeviceId)', () => {
    it('hashes the platform machine id when one is readable', async () => {
        // Cover both platforms: macOS ioreg IOPlatformUUID + Linux /etc/machine-id.
        io.execFileSync.mockReturnValue('  "IOPlatformUUID" = "HWIP-TEST-MACHINE-ID-0001"\n');
        io.readFileSync.mockImplementation((p: string) => {
            if (p === '/etc/machine-id') return 'HWIP-TEST-MACHINE-ID-0001';
            throw new Error('ENOENT');
        });
        const { listenerDeviceId } = await import('./config.js');
        expect(listenerDeviceId()).toBe(GOLDEN_MACHINE_ID);
    });

    it('falls back to a hostname hash when no machine id or sticky file exists', async () => {
        io.execFileSync.mockImplementation(() => {
            throw new Error('no ioreg');
        });
        io.readFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        io.hostname.mockReturnValue('hwip-test-host');
        const { listenerDeviceId } = await import('./config.js');
        expect(listenerDeviceId()).toBe(GOLDEN_HOSTNAME);
    });

    // C98: cli bounds ioreg at the same 5 s (listener-device-id.ts IOREG_TIMEOUT_MS) and its
    // test pins this same GOLDEN_HOSTNAME for a timed-out ioreg. If one side waited longer or
    // fell back differently, a wedged ioreg would give the listener and hwip_ask two ids.
    describe('when ioreg stalls', () => {
        const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        afterEach(() => Object.defineProperty(process, 'platform', realPlatform));

        it('gives up after 5 s and falls back to the hostname hash cli computes', async () => {
            Object.defineProperty(process, 'platform', { value: 'darwin' });
            io.execFileSync.mockImplementation(() => {
                throw Object.assign(new Error('spawnSync /usr/sbin/ioreg ETIMEDOUT'), { code: 'ETIMEDOUT' });
            });
            io.readFileSync.mockImplementation(() => {
                throw new Error('ENOENT');
            });
            io.hostname.mockReturnValue('hwip-test-host');
            const { listenerDeviceId } = await import('./config.js');
            expect(listenerDeviceId()).toBe(GOLDEN_HOSTNAME);
            expect(io.execFileSync.mock.calls[0]![0]).toBe('/usr/sbin/ioreg');
            expect(io.execFileSync.mock.calls[0]![2]).toMatchObject({ timeout: 5_000 });
        });
    });
});
