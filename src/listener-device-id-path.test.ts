import { afterEach, describe, expect, it, vi } from 'vitest';

// On macOS the device id is a hash of the machine id read with `ioreg`, which lives in
// /usr/sbin. A process whose PATH lacks that directory used to fall back to a hostname
// hash: the same Mac under another id, and hwip_ask unthreaded from the agent chat.
const realPath = process.env.PATH;

afterEach(() => {
    process.env.PATH = realPath;
    vi.resetModules();
});

const idUnder = async (path: string | undefined): Promise<string> => {
    process.env.PATH = path;
    vi.resetModules();
    const { listenerDeviceId } = await import('./config.js');
    return listenerDeviceId();
};

describe.runIf(process.platform === 'darwin')('listenerDeviceId does not depend on PATH (macOS)', () => {
    it('is the same under a PATH without /usr/sbin', async () => {
        const full = await idUnder(realPath);

        expect(await idUnder('/usr/bin:/bin')).toBe(full);
        expect(await idUnder('')).toBe(full);
    });
});
