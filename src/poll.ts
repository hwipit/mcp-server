import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { ApiError, isTransient, serverMessage, type HwipApiClient } from './api-client.js';
import type { HookEventResponse } from './types.js';
import type { HookResponseWaiter, WaitSubscription } from './ws-wait.js';

export interface PollContext {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: ServerNotification) => Promise<void>;
  /** Fires when the agent cancels the tool call — the wait ends with it. */
  signal?: AbortSignal;
}

/**
 * How a wait ended without an answer, other than the deadline. Each code tells
 * the agent something different to do next, which is the point of having them.
 */
export type AskFailure = 'CANCELLED' | 'POLL_FAILED' | 'ABORTED';

export class AskError extends Error {
  constructor(
    public readonly code: AskFailure,
    message: string,
    public readonly eventId: string,
  ) {
    super(message);
    this.name = 'AskError';
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Never settles — the stand-in for a race arm that is absent. */
const never = new Promise<never>(() => undefined);

/** Rejects once `signal` aborts; never settles without one. `release` drops the listener. */
const abortOf = (signal: AbortSignal | undefined, eventId: string): { aborted: Promise<never>; release: () => void } => {
  if (!signal) return { aborted: never, release: () => undefined };
  let fail = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    fail = () => reject(new AskError('ABORTED', 'The tool call was cancelled', eventId));
  });
  aborted.catch(() => undefined);
  if (signal.aborted) fail();
  else signal.addEventListener('abort', fail, { once: true });
  return { aborted, release: () => signal.removeEventListener('abort', fail) };
};

/** Backoff after `failures` consecutive failed reads: 1s, 2s, 4s … capped at 15s. */
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 15_000;
const retryDelay = (failures: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_CAP_MS);

const PROGRESS_INTERVAL_SECONDS = 5;

// While the WS fast path is live, polling is only the consistency
// backstop — 10s is plenty. The WS wake races the sleep, so a live
// answer still lands in sub-second time (SPEC-AGENT-AWARENESS §S3).
const WS_BACKSTOP_INTERVAL_MS = 10_000;
// After a WS wake, REST may briefly still read 'pending' (DDB eventual
// consistency) — retry tightly but boundedly.
const POST_WAKE_RETRY_MS = 500;

export const pollForResponse = async (
  client: HwipApiClient,
  hookId: string,
  eventId: string,
  timeoutSeconds: number,
  ctx: PollContext,
  waiter?: HookResponseWaiter,
): Promise<HookEventResponse | null> => {
  const progressToken = ctx._meta?.progressToken;
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  let attempt = 0;
  let lastProgressAt = 0;

  let sub: WaitSubscription | undefined;
  let wsSettled = false;
  if (waiter?.canWait()) {
    sub = waiter.subscribe(eventId);
    void sub.settled.then(() => { wsSettled = true; });
  }

  const { aborted, release } = abortOf(ctx.signal, eventId);
  // Raced so a cancelled call returns now, not after an in-flight read.
  const untilAborted = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]);
  const wake = sub?.settled ?? never;

  // Throttled progress notification (every 5s) — sent through outages too, so
  // a client that keeps the call alive on progress does not give up mid-retry.
  const reportProgress = async (): Promise<void> => {
    if (progressToken === undefined) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed - lastProgressAt < PROGRESS_INTERVAL_SECONDS) return;
    lastProgressAt = elapsed;
    await ctx.sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: elapsed,
        total: timeoutSeconds,
        message: `Waiting for user response... (${elapsed}s / ${timeoutSeconds}s)`,
      },
    });
  };

  let failures = 0;
  let seen = false;
  let lastReadAt: number | undefined;
  let lastError: unknown;

  try {

    while (Date.now() - startTime < timeoutMs) {
      let event: HookEventResponse;
      try {
        event = await untilAborted(client.getHookEvent(hookId, eventId));
      } catch (err) {
        // A 404 before the first good read is the server's eventually
        // consistent read missing the event the trigger just wrote.
        const unseen404 = !seen && err instanceof ApiError && err.status === 404;
        if (err instanceof AskError || !(isTransient(err) || unseen404)) throw err;
        // One failed read is not the end of the question: it is still on the
        // phone, and giving up here would leave the answer with nobody to
        // receive it while the agent asks again. Back off and read again.
        failures++;
        lastError = err;
        await reportProgress();
        const remaining = timeoutMs - (Date.now() - startTime);
        await untilAborted(Promise.race([sleep(Math.max(0, Math.min(retryDelay(failures), remaining))), wake]));
        continue;
      }
      failures = 0;
      seen = true;
      lastReadAt = Date.now();

      if (event.data.status === 'responded') return event;
      if (event.data.status === 'cancelled') {
        throw new AskError('CANCELLED', 'The user cancelled this question on their phone', eventId);
      }
      if (event.data.status === 'timed_out') return null;
      // Only 'pending' should keep us polling. Anything else is server
      // contract drift — fail fast instead of spinning until the timeout.
      if (event.data.status !== 'pending') {
        throw new Error(`Unexpected hook event status: ${serverMessage(String(event.data.status), 'unreadable')}`);
      }

      await reportProgress();

      if (wsSettled) {
        // Server said settled but this read still saw 'pending' —
        // eventual consistency. Tight bounded retry until reads agree.
        await untilAborted(sleep(POST_WAKE_RETRY_MS));
        attempt++;
        continue;
      }

      // Adaptive interval: poll every 1s while the user is likely still at
      // their device (first ~60 attempts ≈ 1 min), then back off to 3s for
      // long waits. The tight 1s window keeps post-tap detection snappy.
      // With a live WS subscription the cadence relaxes to a backstop and
      // the wake race handles snappiness instead.
      const interval = sub?.isConnected()
        ? WS_BACKSTOP_INTERVAL_MS
        : (attempt < 60 ? 1000 : 3000);
      await untilAborted(Promise.race([sleep(interval), wake]));
      attempt++;
    }

    // The deadline passed with the server unreadable for a while (not one
    // stray failure after minutes of clean reads): that is not a timeout the
    // user caused, and the answer may have landed unseen.
    const blind = lastReadAt === undefined || Date.now() - lastReadAt > RETRY_CAP_MS;
    if (failures > 0 && blind) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new AskError(
        'POLL_FAILED',
        `Lost contact with the hwip server while waiting (${reason}). The user may have answered, or the question expired, without this call seeing it.`,
        eventId,
      );
    }
    return null;
  } finally {
    release();
    sub?.dispose();
  }
};
