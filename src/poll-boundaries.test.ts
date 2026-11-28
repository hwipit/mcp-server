import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollForResponse } from './poll.js';
import type { HwipApiClient } from './api-client.js';
import type { HookEventResponse } from './types.js';

// Boundary tests for pollForResponse: wait caps, abort handling, backoff and
// progress numbers. All on fake timers, so the real-second waits cost nothing.

type Step = Error | HookEventResponse['data'];
type Waiter = Parameters<typeof pollForResponse>[5];

const pending = { eventId: 'e1', status: 'pending' } as const;
const ctx0 = { sendNotification: vi.fn() };

/** Records the (fake) time of every read; steps are consumed per call and the last repeats. */
const timedClient = (steps: Step[]) => {
    const reads: number[] = [];
    const t0 = Date.now();
    const client = {
        getHookEvent: vi.fn(async () => {
            reads.push(Date.now() - t0);
            const step = steps[Math.min(reads.length - 1, steps.length - 1)];
            if (step instanceof Error) throw step;
            return { data: step };
        }),
    } as unknown as HwipApiClient;
    return { client, reads };
};

const waiter = (opts: { connected?: boolean; settled?: Promise<void>; canWait?: boolean } = {}) => {
    const subscribe = vi.fn(() => ({
        settled: opts.settled ?? new Promise<void>(() => undefined),
        isConnected: () => opts.connected ?? true,
        dispose: vi.fn(),
    }));
    return { subscribe, waiter: { canWait: () => opts.canWait ?? true, subscribe } as unknown as Waiter };
};

describe('pollForResponse — wait caps', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('cuts the last backstop sleep to the time left, so the deadline read is on time', async () => {
        const { client, reads } = timedClient([pending]);
        const p = pollForResponse(client, 'h', 'e1', 15, ctx0 as never, waiter().waiter);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await p).toBeNull();
        expect(reads).toEqual([0, 10_000, 15_000]);
    });

    it('polls every second for 60 reads, then every 3s', async () => {
        const { client, reads } = timedClient([pending]);
        const p = pollForResponse(client, 'h', 'e1', 200, ctx0 as never);
        await vi.advanceTimersByTimeAsync(70_000);
        expect(reads.slice(58, 63)).toEqual([58_000, 59_000, 60_000, 63_000, 66_000]);
        await vi.advanceTimersByTimeAsync(200_000);
        await p;
    });

    it('re-reads every 500ms while the WS says settled but the read still says pending', async () => {
        const { client, reads } = timedClient([pending]);
        const w = waiter({ settled: Promise.resolve() }).waiter;
        const p = pollForResponse(client, 'h', 'e1', 1.2, ctx0 as never, w);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await p).toBeNull();
        // The last sleep is cut to the 200ms left, so the deadline read is on time.
        expect(reads).toEqual([0, 500, 1000, 1200]);
    });
});

describe('pollForResponse — abort', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('rejects at once with ABORTED, without any read, when the signal is already aborted', async () => {
        const { client } = timedClient([pending]);
        const p = pollForResponse(client, 'h', 'e1', 60, { ...ctx0, signal: AbortSignal.abort() } as never);
        const outcome = p.then((v) => v, (e: unknown) => e);
        await vi.advanceTimersByTimeAsync(70_000);
        expect(await outcome).toMatchObject({ code: 'ABORTED', eventId: 'e1' });
        expect(client.getHookEvent).toHaveBeenCalledTimes(0);
    });

    it('leaves no abort listener behind once the wait has ended', async () => {
        const ac = new AbortController();
        const { client } = timedClient([{ eventId: 'e1', status: 'responded', response: {} }]);
        await pollForResponse(client, 'h', 'e1', 60, { ...ctx0, signal: ac.signal } as never);
        expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
    });

    it('raises no unhandled rejection when the abort lands between two races', async () => {
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const unhandled: unknown[] = [];
        const onUnhandled = (e: unknown): void => { unhandled.push(e); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const ac = new AbortController();
            let release: () => void = () => undefined;
            const sendNotification = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
            const { client } = timedClient([pending]);
            const p = pollForResponse(client, 'h', 'e1', 60,
                { _meta: { progressToken: 't' }, sendNotification, signal: ac.signal } as never);
            const outcome = p.then((v) => v, (e: unknown) => e);
            await vi.advanceTimersByTimeAsync(5_500); // the 5s progress notice is now in flight
            expect(sendNotification).toHaveBeenCalledTimes(1);
            ac.abort(); // no race is attached while the notice is awaited
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            expect(unhandled).toEqual([]);
            release();
            expect(await outcome).toMatchObject({ code: 'ABORTED' });
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('does not subscribe to a waiter that cannot wait', async () => {
        const { client } = timedClient([{ eventId: 'e1', status: 'responded', response: {} }]);
        const w = waiter({ canWait: false });
        await pollForResponse(client, 'h', 'e1', 60, ctx0 as never, w.waiter);
        expect(w.subscribe).not.toHaveBeenCalled();
    });
});

describe('pollForResponse — backoff and progress numbers', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const down = () => new TypeError('fetch failed');

    it('caps the retry backoff at 15s', async () => {
        const { client, reads } = timedClient([down()]);
        const p = pollForResponse(client, 'h', 'e1', 100, ctx0 as never).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(101_000);
        await p;
        expect(reads.slice(0, 7)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000]);
    });

    it('goes back to a 1s backoff after a read succeeds', async () => {
        const { client, reads } = timedClient([down(), down(), down(), pending, down(), pending]);
        const p = pollForResponse(client, 'h', 'e1', 20, ctx0 as never);
        await vi.advanceTimersByTimeAsync(21_000);
        await p;
        // Reads 0,1,3 fail (1s,2s,4s), 7 is ok, 8 fails: a fresh count waits 1s, not 8s.
        expect(reads.slice(0, 7)).toEqual([0, 1_000, 3_000, 7_000, 8_000, 9_000, 10_000]);
    });

    it('sends progress every 5s with the elapsed seconds and the total', async () => {
        const sendNotification = vi.fn(async () => undefined);
        const { client } = timedClient([pending]);
        const p = pollForResponse(client, 'h', 'e1', 12, { _meta: { progressToken: 'tok' }, sendNotification } as never);
        await vi.advanceTimersByTimeAsync(13_000);
        expect(await p).toBeNull();
        expect(sendNotification.mock.calls.map(([n]) => n)).toEqual([5, 10].map((elapsed) => ({
            method: 'notifications/progress',
            params: {
                progressToken: 'tok',
                progress: elapsed,
                total: 12,
                message: `Waiting for user response... (${elapsed}s / 12s)`,
            },
        })));
    });
});
