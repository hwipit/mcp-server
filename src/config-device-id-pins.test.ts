import { afterEach, describe, expect, it, vi } from 'vitest';

// Pins for listenerDeviceId's inputs (t96 note #1): a stored id with a 0 in it, the ioreg line it
// hashes, and the Linux machine-id fallthrough. The goldens are sha256(seed).slice(0, 8), fixed here
// so a change to the seed source or the pattern breaks a test.

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

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const onPlatform = (value: string) => Object.defineProperty(process, 'platform', { value });

afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    vi.clearAllMocks();
    vi.resetModules();
});

const enoent = () => {
    throw new Error('ENOENT');
};

describe('the sticky listener id file', () => {
    const noMachineId = () => {
        onPlatform('freebsd');
        io.hostname.mockReturnValue('hwip-test-host');
    };

    it.each(['dev_listener_00000000', 'dev_listener_0abcdef1', 'dev_listener_9f0a1b2c'])('takes %s: a stored id holds 0s as often as any digit', async (stored) => {
        noMachineId();
        io.readFileSync.mockImplementation((p: string) => (p.endsWith('listener-device-id') ? `${stored}\n` : enoent()));
        const { listenerDeviceId } = await import('./config.js');
        expect(listenerDeviceId()).toBe(stored);
    });

    it.each(['dev_listener_0000000', 'dev_listener_000000000', 'dev_listener_0000000G', 'dev_listener_0000000A'])('drops %s for the hostname hash', async (stored) => {
        noMachineId();
        io.readFileSync.mockImplementation((p: string) => (p.endsWith('listener-device-id') ? stored : enoent()));
        const { listenerDeviceId } = await import('./config.js');
        expect(listenerDeviceId()).toBe('dev_listener_e82c9f59');
    });
});

describe('the machine id it hashes', () => {
    it('hashes the quoted IOPlatformUUID value of an ioreg dump, not the whole line', async () => {
        onPlatform('darwin');
        io.execFileSync.mockReturnValue('+-o Root\n  | {\n  |   "IOPlatformSerialNumber" = "SERIAL"\n  |   "IOPlatformUUID" = "ABC"\n  | }\n');
        io.readFileSync.mockImplementation(enoent);
        const { listenerDeviceId } = await import('./config.js');
        expect(listenerDeviceId()).toBe('dev_listener_b5d4045c');
    });

    it('skips an empty /etc/machine-id and takes the second file on linux', async () => {
        onPlatform('linux');
        io.readFileSync.mockImplementation((p: string) => {
            if (p === '/etc/machine-id') return ' \n';
            if (p === '/var/lib/dbus/machine-id') return 'LINUX-ID\n';
            return enoent();
        });
        const { listenerDeviceId } = await import('./config.js');
        expect(listenerDeviceId()).toBe('dev_listener_af95d2bc');
    });

    it('takes the second linux file when the first is missing', async () => {
        onPlatform('linux');
        io.readFileSync.mockImplementation((p: string) => (p === '/var/lib/dbus/machine-id' ? 'LINUX-ID' : enoent()));
        const { listenerDeviceId } = await import('./config.js');
        expect(listenerDeviceId()).toBe('dev_listener_af95d2bc');
    });

    it('does not read the linux machine-id files on macOS', async () => {
        onPlatform('darwin');
        io.execFileSync.mockImplementation(enoent);
        io.hostname.mockReturnValue('hwip-test-host');
        io.readFileSync.mockImplementation((p: string) => (p === '/etc/machine-id' ? 'LINUX-ID' : enoent()));
        const { listenerDeviceId } = await import('./config.js');
        expect(listenerDeviceId()).toBe('dev_listener_e82c9f59');
    });

    it('does not run ioreg on linux', async () => {
        onPlatform('linux');
        io.readFileSync.mockImplementation((p: string) => (p === '/etc/machine-id' ? 'LINUX-ID' : enoent()));
        const { listenerDeviceId } = await import('./config.js');
        listenerDeviceId();
        expect(io.execFileSync).not.toHaveBeenCalled();
    });
});
