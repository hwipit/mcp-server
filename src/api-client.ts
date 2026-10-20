import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from './config.js';
import { isRedirectRefusal } from './redirect.js';
import { uploadContentType } from './mime.js';
import { downloadUrlProblem } from './url-check.js';
import type {
  ApiErrorBody,
  PushResponse,
  HookTriggerResponse,
  HookEventResponse,
  DevicesResponse,
  DeviceKeyResponse,
  AgentSessionRenameResponse,
  PushListResponse,
  DismissResponse,
  ChannelsResponse,
  UploadRequestResponse,
  AttachedFile,
  LanDeliveredFile,
} from './types.js';

export class ApiError extends Error {
  /** The request cannot have been sent: no connection was ever made. */
  public readonly unsent: boolean;
  /** The transport's own code for a call that got no reply (`ECONNRESET`), when it gave one. */
  public readonly causeCode?: string;
  /** A reply this client would not read to the end: the server answered, whatever it said. */
  public readonly unreadReply: boolean;

  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    transport: { unsent?: boolean; causeCode?: string; unreadReply?: boolean } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.unsent = transport.unsent ?? false;
    this.causeCode = transport.causeCode;
    this.unreadReply = transport.unreadReply ?? false;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;

/** Pauses before the tries that follow a trigger failure that may pass: four tries in all. */
const TRIGGER_BACKOFF_MS = [1_000, 2_000, 4_000];
/**
 * A first request still running under the key answers a retry with 409 until it ends. One the server
 * lost to its own timeout never ends: the key stays taken for 30 s (hwip `server/src/entities/idempotency.ts`
 * STALE_CLAIM_MS, read 2026-10-14) and a retry after that starts a new request. So these tries are
 * counted apart from the ones above, and go on until that hold has passed: seven more, 35 s of
 * waiting from the first 409. The key was taken before that answer, so the last try comes after the
 * hold whatever the first request took to fail.
 */
const IN_PROGRESS_RETRY_MS = 5_000;
const IN_PROGRESS_RETRIES = 7;

/**
 * A failed call that a later one may well get past: the network (NETWORK_ERROR,
 * status 0), a reply that could not be read (BAD_RESPONSE, status 0), the
 * request's own timeout, a rate limit, a server error. A 4xx
 * other than 408 and 429 is an answer about the request itself (bad key, hook
 * gone) and will say the same thing every time — and so does a refused redirect
 * (REDIRECT_REFUSED, also status 0): the base URL sends the request elsewhere
 * on every call. Nor does a base URL that is not an address get to be one.
 */
export const isTransient = (err: unknown): boolean =>
  !(err instanceof ApiError)
  || (err.code !== 'REDIRECT_REFUSED' && err.causeCode !== 'ERR_INVALID_URL'
    && (err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500));

/**
 * The errnos of a connection that could not be made, each with the call that says so. Under any other
 * call the socket had been connected, and the request may have been written to it: a reset is reported
 * under `read` (seen on Node 24.21), and "no route" is taken to come the same way (not reproduced).
 */
const BEFORE_CONNECTING = new Map([
  ['ENOTFOUND', 'getaddrinfo'],
  ['EAI_AGAIN', 'getaddrinfo'],
  ['ECONNREFUSED', 'connect'],
  ['ENETUNREACH', 'connect'],
  ['EHOSTUNREACH', 'connect'],
  ['ETIMEDOUT', 'connect'],
]);
/** undici's own "the connect got no answer", and `fetch` handed an address it could not parse: neither has a call to go by, or needs one. */
const NEVER_STARTED = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL']);

/**
 * Did `fetch` fail, by this cause, before the request could be sent? A connect or a lookup that
 * failed, or — a host with several addresses — every one of them failing so. The shapes are Node
 * 24.21's (undici 7.29), read 2026-10-14: `{ code, syscall }`, and an `AggregateError` of them.
 */
const failedBeforeConnecting = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false;
  const { code, syscall, errors } = cause as { code?: unknown; syscall?: unknown; errors?: unknown };
  if (typeof code !== 'string') return false;
  if (NEVER_STARTED.has(code)) return true;
  if (cause instanceof AggregateError) return Array.isArray(errors) && errors.length > 0 && errors.every(failedBeforeConnecting);
  const call = BEFORE_CONNECTING.get(code);
  return call !== undefined && syscall === call;
};

/**
 * A failed send the server may have taken all the same: a slow answer, one that could not be read, a 5xx
 * (a gateway that gave up on a request already written), a first send still running, a connection that
 * dropped once made. Not its own "too many", and not a connection that was never made.
 */
const mayHaveLanded = (err: unknown): boolean =>
  !(err instanceof ApiError) || (err.status !== 429 && !err.unsent);

/** The time a client waits by. Injected so a test does not sit out the pauses. */
export interface Clock {
  now: () => number;
  /** Rejects with the signal's reason when it aborts first. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const wallClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  }),
};

/**
 * The largest file any tier can send — Pro's 1 GiB (`fileMaxBytes` in hwip's
 * shared tier-limits). The account's own tier still decides below this; the cap
 * only stops a transfer no tier could accept from being read into memory.
 */
export const MAX_FILE_BYTES = 1_073_741_824;

/**
 * The most a JSON reply (or an error body) may weigh. The API's own replies are
 * a few KiB, a push list tens; 8 MiB is far past any real one and still small
 * enough that a wrong or hostile host cannot make this process hold gigabytes.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** An error body is read only to be shown, so it gets a much smaller bound. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** The longest server-worded message passed on to the model. */
const MAX_SERVER_MESSAGE_CHARS = 300;

/** What an API error code looks like. Anything else is not one the API sent. */
const ERROR_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * What a one-line message cannot carry: control characters (Cc), the invisible
 * format characters (Cf — bidi marks and overrides, zero-width space, the BOM,
 * and the Unicode tag block that can hide text from a reader but not from a
 * model), the grapheme-join blocker U+034F, and the Hangul fillers (U+115F,
 * U+1160, U+3164, U+FFA0 — blank letters an attacker would use as an invisible
 * base character), and line and paragraph separators. U+200C ZWNJ and U+200D ZWJ
 * are writing, not hiding (Persian, Hindi, emoji sequences), so a lone one
 * stays — but a run of them is a bit channel, so a run collapses to its first
 * character (C153). Selectors go by allowlist, not by run: U+FE0E/U+FE0F stay
 * only after an emoji base (text/emoji presentation), U+E0100–E01EF only after a
 * unified ideograph (IVS); every other selector — including the Mongolian FVS
 * (U+180B–U+180D, U+180F) — goes, so spacing a run out with an invisible
 * character no longer smuggles it past the rule. The same rule as cli's
 * `UNPRINTABLE` block (src/http-failure.ts): the lines below from
 * `const UNPRINTABLE` through `sanitizeSmuggled` are character-identical there.
 */
export const UNPRINTABLE = /(?:[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf}|[\u034F\u115F\u1160\u3164\uFFA0])+/gu;
// Written with \u{...}: \uE0100 would read as U+E010 plus "0", turning 0-\uE01E into a range over ASCII (C153).
const SELECTOR_ALLOW = /(\p{Emoji}|[0-9#*])([\uFE0E\uFE0F])|(\p{Unified_Ideograph})([\u{E0100}-\u{E01EF}])|[\uFE00-\uFE0F\u180B-\u180D\u180F\u{E0100}-\u{E01EF}]/gu;
const JOINER_RUN = /([\u200C\u200D])[\u200C\u200D]+/gu;
// '$1$2$3$4' rebuilds an allowed base + selector and erases anything else (groups that did not match are empty).
const sanitizeSmuggled = (text: string): string => text.replace(SELECTOR_ALLOW, '$1$2$3$4').replace(JOINER_RUN, '$1');

/**
 * The server's own wording, made safe to hand to the model: one line, control
 * characters gone, cut to a fixed length. A reply from a hijacked or mistaken
 * host could otherwise put a paragraph of instructions into the tool result.
 */
export const serverMessage = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const clean = sanitizeSmuggled(value.replace(UNPRINTABLE, ' ')).trim();
  if (!clean) return fallback;
  // By code point: a cut through a surrogate pair would leave half an emoji.
  const points = Array.from(clean);
  return points.length > MAX_SERVER_MESSAGE_CHARS ? `${points.slice(0, MAX_SERVER_MESSAGE_CHARS - 1).join('')}…` : clean;
};

const responseTooLarge = (max: number): ApiError =>
  new ApiError(`The hwip API's reply is larger than ${max} bytes, so it was not read`, 'RESPONSE_TOO_LARGE', 413, { unreadReply: true });

/**
 * The body of `response`, refused as soon as it passes `max` bytes. Content-Length
 * is only a claim — it can be absent, wrong, or beaten by chunked encoding — so
 * the bytes actually read are what is counted, and the stream is cancelled at the cap.
 */
const readCapped = async (response: Response, max: number, tooBig: (declared?: number) => ApiError): Promise<Uint8Array> => {
  const declared = Number(response.headers.get('content-length'));
  if (declared > max) {
    // Refused unread: free the connection instead of leaving it to GC.
    await response.body?.cancel().catch(() => undefined);
    throw tooBig(declared);
  }
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > max) throw tooBig();
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};

export const readCappedText = async (response: Response, max: number): Promise<string> =>
  new TextDecoder().decode(await readCapped(response, max, () => responseTooLarge(max)));

/** The slowest link a file transfer is still waited on over: 1 MiB/s. */
const TRANSFER_BYTES_PER_SEC = 1024 * 1024;

/** A file transfer's timeout: the usual request budget plus time for its bytes. */
export const transferTimeoutMs = (bytes: number): number =>
  DEFAULT_TIMEOUT_MS + Math.ceil((bytes / TRANSFER_BYTES_PER_SEC) * 1000);

/**
 * The per-request timeout, ended early by `outer` (the tool call's own abort)
 * when one is given. Hand-rolled because `AbortSignal.any` needs Node 20.3 and
 * the package supports 18.17. Each signal aborts with its own reason, so a
 * timeout still reads as `TimeoutError` and a cancel as `AbortError`.
 * `release` drops the listener on `outer` once the request has settled.
 * Exported for tests.
 */
export const requestSignal = (timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; release: () => void } => {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!outer) return { signal: timeout, release: () => undefined };
  const combined = new AbortController();
  const fromOuter = () => combined.abort(outer.reason);
  if (outer.aborted) fromOuter();
  else outer.addEventListener('abort', fromOuter, { once: true });
  timeout.addEventListener('abort', () => combined.abort(timeout.reason), { once: true });
  return { signal: combined.signal, release: () => outer.removeEventListener('abort', fromOuter) };
};

/** An event id as it goes into the path its answer is read from: the server's (`hevt_` + ULID). The cli holds a saved one to the same shape (`ask-pending.ts`). */
const EVENT_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** What a request id may be before it goes into a path: hook, event, push and device ids are all
 *  server-shaped (`hevt_` + ULID, `push_…`, `hook_…`, `dev_…`), so anything else — `..`, a `/`,
 *  an empty string — is a caller bug, refused before `fetch` can fold the path (`/pushes/../dismiss`
 *  reads as `/dismiss`). M40. */
const PATH_ID_SHAPE = EVENT_ID_SHAPE;

const assertPathId = (kind: string, value: string): void => {
  if (!PATH_ID_SHAPE.test(value)) {
    throw new ApiError(`Invalid ${kind}: not an id this client sends`, 'INVALID_ID', 400);
  }
};

/** A tmux session name as it goes into the rename path. The server keys nearly anything
 *  (`isSessionMapKey`, only `__proto__` refused), and tmux names can carry spaces, so this is not
 *  the id shape above — only what would break out of the path segment. */
const assertSessionName = (value: string): void => {
  if (value.length === 0 || value.length > 128 || value === '.' || value === '..' || value === '__proto__' || /[\/\0-\x1f\x7f]/.test(value)) {
    throw new ApiError('Invalid session name: not a name this client sends', 'INVALID_ID', 400);
  }
};

/** A transport's code as Node and undici write them (`ECONNRESET`, `UND_ERR_SOCKET`): a word, never a sentence. */
const TRANSPORT_CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,40}$/;

/**
 * A failure's words without the userinfo of an address in them: stderr is a log that may be shared
 * (url-check.ts). Up to the last `@` before the path — a password may hold one, or a space, as written.
 */
const withoutUserinfo = (words: string): string => words.replace(/\/\/[^/?#]*@/g, '//');

/**
 * A request that never got a reply. A write may still have landed — the
 * server can act and the answer be what was lost — so the message says so for
 * anything but a read.
 */
const transportError = (err: unknown, method: string): ApiError | null => {
  const landedNote = method === 'GET' ? '' : ' The request may still have reached the server.';
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new ApiError(`The hwip API did not answer in time.${landedNote}`, 'API_TIMEOUT', 408);
  }
  // fetch rejects with a TypeError when no response came back at all: DNS,
  // refused connection, reset, TLS.
  if (err instanceof TypeError) {
    if (isRedirectRefusal(err)) {
      return new ApiError(
        'The hwip API answered with a redirect, and this server does not follow one with your API key.',
        'REDIRECT_REFUSED',
        0,
      );
    }
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause; // fetch's own shape: undici hangs the socket's error here
    // A reset is a TypeError as well, and may be of a request the server took: only a failed connect says it was never sent.
    const unsent = failedBeforeConnecting(cause);
    const causeCode = typeof cause?.code === 'string' && TRANSPORT_CODE_SHAPE.test(cause.code) ? cause.code : undefined;
    // The code and no more: a failure's words may quote what was sent (a header's value, an address with
    // a password in it), and this message goes to the model. With no code to give, the words go to stderr, less that password.
    if (causeCode === undefined) {
      // A code that is not written as one is words too: left out above, and still what to look for here.
      const said = [err.message, cause?.code, cause?.message].filter((part): part is string => typeof part === 'string');
      console.error('[api] no reply:', withoutUserinfo(said.join(' — ')));
    } else {
      // M41: the code alone travels with the error; its words (a TLS certificate's detail, the address
      // tried) go to stderr instead, with any userinfo stripped — they never reached the model before.
      const said = [err.message, cause?.message].filter((part): part is string => typeof part === 'string');
      const detail = withoutUserinfo(said.join(' — '));
      if (detail) console.error(`[api] no reply (${causeCode}):`, detail);
    }
    return new ApiError(`Could not reach the hwip API${causeCode === undefined ? '' : ` (${causeCode})`}.${unsent ? '' : landedNote}`, 'NETWORK_ERROR', 0, { unsent, causeCode });
  }
  return null;
};

export class HwipApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: McpServerConfig, private readonly clock: Clock = wallClock) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
  }

  async sendPush(params: {
    title?: string;
    body?: string;
    url?: string;
    type?: string;
    priority?: string;
    targetDeviceId?: string;
    /** With `type: 'agent.command'`: the tmux session on `targetDeviceId` to type the body into. */
    agentSessionName?: string;
    /** Listener device id. With `agentSessionName`, threads a file/notify into that agent chat instead of resolving `sessionId` (which can be a sibling Claude session in the same project). */
    agentDeviceId?: string;
    channelId?: string;
    sessionId?: string;
    files?: (AttachedFile | LanDeliveredFile)[];
    isEncrypted?: boolean;
    senderPublicKey?: string;
    deviceKeyMap?: Record<string, string>;
  }): Promise<PushResponse> {
    return this.request<PushResponse>('POST', '/pushes/send', params);
  }

  async triggerHook(
    hookId: string,
    params: {
      title?: string;
      body?: string;
      actions?: { id: string; label?: string; style?: string }[];
      /** A sealed question: `body`, `senderPublicKey` and `deviceKeyMap` hold the envelope (ask-seal.ts). */
      isEncrypted?: true;
      senderPublicKey?: string;
      deviceKeyMap?: Record<string, string>;
      timeout?: number;
      fallback?: string;
      metadata?: Record<string, unknown>;
      hookType?: 'combo';
      /** This ask settles an `exitRemote` answer (tools/ask.ts). */
      acceptsExit?: boolean;
      /** This asker saves files attached to a sealed answer; without it the phone offers none. */
      acceptsFiles?: boolean;
      files?: AttachedFile[];
      sessionId?: string;
      /** Stable session grouping so the hook joins the agent chat. */
      agentDeviceId?: string;
      agentSessionName?: string;
    },
    signal?: AbortSignal,
    /**
     * Sending again: for how long from now the question is still worth it, and who to tell before
     * each wait (with how many there have been). Without it, one try.
     */
    retry?: { withinMs: number; onRetry?: (tries: number) => Promise<void> },
  ): Promise<HookTriggerResponse> {
    assertPathId('hookId', hookId);
    // Every try carries the same key and the same bytes: the server answers a repeat with the first
    // question's ids only when its body is the first one's, and refuses another body under the key
    // (422). What the key does not cover (hwip `server/SERVER-API.md`, the trigger's
    // `Idempotency-Key`, read 2026-10-14): a first request that wrote the question and died before it
    // marked the key is taken over after its 30 s hold, and that try opens a second question.
    const payload = { body: JSON.stringify(params), headers: { 'Idempotency-Key': randomUUID() } };
    const path = `/hooks/${encodeURIComponent(hookId)}/trigger`;
    const firstSent = this.clock.now();
    let backoffs = 0;
    let inProgress = 0;
    /** Some try so far may have reached the server, whatever the last one says. */
    let unsure = false;
    let taken: HookTriggerResponse;
    for (let tries = 1; ; tries += 1) {
      try {
        taken = await this.send<HookTriggerResponse>('POST', path, payload, DEFAULT_TIMEOUT_MS, signal);
        break;
      } catch (err) {
        if (signal?.aborted || !retry) throw err;
        const running = err instanceof ApiError && err.code === 'IDEMPOTENCY_IN_PROGRESS';
        const again = running || isTransient(err);
        // A 2xx too large to read is not sent again, and is the server saying it took the question. Told by
        // the client's own mark, not by the code: a server may write the same word in a refusal.
        if (again || (err instanceof ApiError && err.unreadReply)) unsure ||= mayHaveLanded(err);
        const wait = !again
          ? undefined
          : running
            ? (inProgress++ < IN_PROGRESS_RETRIES ? IN_PROGRESS_RETRY_MS : undefined)
            : TRIGGER_BACKOFF_MS[backoffs++];
        if (wait === undefined || this.clock.now() + wait - firstSent >= retry.withinMs) {
          if (!unsure) throw err;
          // The last failure alone would send the caller the wrong way: "retry later" after a first try
          // that timed out asks the question twice. Said in this client's words, not the last reply's.
          // Its code or its kind, not its words: those may be the server's, or quote what was sent. A failure
          // that is none of this client's own goes to stderr by name and code only (M40: never whole —
          // its message may quote what was sent). Only the user reads it.
          if (!(err instanceof ApiError)) {
            const errCode = (err as { code?: unknown }).code;
            const kind = err instanceof Error
              ? `${err.name}${typeof errCode === 'string' && errCode ? ` (${errCode})` : ''}`
              : typeof err;
            console.error(`[api] send failed: ${kind}`);
          }
          const last = err instanceof ApiError
            ? [err.code, err.status || undefined, err.causeCode].filter((part) => part !== undefined).join(' ')
            : err instanceof Error ? err.name : 'no reply';
          throw new ApiError(
            `Sending the question failed after ${tries} ${tries === 1 ? 'try' : 'tries'}, and it may have reached the server all the same (last failure: ${last}).`,
            'SEND_UNCONFIRMED',
            err instanceof ApiError ? err.status : 0,
          );
        }
        // Telling the caller is a courtesy: a failure there does not cost the question its retry.
        await retry.onRetry?.(backoffs + inProgress).catch((e: unknown) => console.error('[api] retry notice failed:', e));
        await this.clock.sleep(wait, signal);
      }
    }
    // The id goes into the path the answer is read from. Not sent again: the question is up, and a
    // repeat under the same key is answered with the same id.
    // A 2xx body is whatever JSON came: `null` parses, and so does a number.
    const eventId: unknown = (taken as HookTriggerResponse | null)?.data?.eventId; // the type is the server's promise, not what a proxy sent
    if (typeof eventId !== 'string' || !EVENT_ID_SHAPE.test(eventId)) {
      throw new ApiError('The hwip API took the question but gave no event id its answer can be read by. The question may be on the phone, and this call cannot read an answer to it.', 'BAD_RESPONSE', 0);
    }
    return taken;
  }

  async getHookEvent(hookId: string, eventId: string): Promise<HookEventResponse> {
    assertPathId('hookId', hookId);
    assertPathId('eventId', eventId);
    return this.request<HookEventResponse>('GET', `/hooks/${encodeURIComponent(hookId)}/events/${encodeURIComponent(eventId)}`, undefined, POLL_TIMEOUT_MS);
  }

  async listDevices(): Promise<DevicesResponse> {
    return this.request<DevicesResponse>('GET', '/devices');
  }

  /** Put this machine's key on the account's device list; `nickname` names it only when the server creates the entry. */
  async registerDeviceKey(deviceId: string, publicKey: string, nickname: string): Promise<DeviceKeyResponse> {
    assertPathId('deviceId', deviceId);
    return this.request<DeviceKeyResponse>('PUT', `/devices/${encodeURIComponent(deviceId)}/public-key`, { publicKey, nickname });
  }

  /** Set (or clear, when `alias` is empty) the display name for an agent
   *  session, keyed by its tmux `name` on `deviceId`. */
  async renameAgentSession(deviceId: string, name: string, alias: string): Promise<AgentSessionRenameResponse> {
    assertPathId('deviceId', deviceId);
    assertSessionName(name);
    return this.request<AgentSessionRenameResponse>(
      'PATCH',
      `/devices/${encodeURIComponent(deviceId)}/agent-sessions/${encodeURIComponent(name)}`,
      { alias },
    );
  }

  /** The name the agent gives its own session — beside the user's alias, never over it. */
  async setAgentSessionAutoName(deviceId: string, name: string, autoName: string): Promise<AgentSessionRenameResponse> {
    assertPathId('deviceId', deviceId);
    assertSessionName(name);
    return this.request<AgentSessionRenameResponse>(
      'PATCH',
      `/devices/${encodeURIComponent(deviceId)}/agent-sessions/${encodeURIComponent(name)}/auto-name`,
      { autoName },
    );
  }

  async listPushes(params?: { limit?: number; type?: string }): Promise<PushListResponse> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.type) query.set('type', params.type);
    const qs = query.toString();
    return this.request<PushListResponse>('GET', `/pushes${qs ? `?${qs}` : ''}`);
  }

  async dismissPush(pushId: string): Promise<DismissResponse> {
    assertPathId('pushId', pushId);
    return this.request<DismissResponse>('POST', `/pushes/${encodeURIComponent(pushId)}/dismiss`);
  }

  async dismissAllPushes(): Promise<DismissResponse> {
    return this.request<DismissResponse>('POST', '/pushes/dismiss-all');
  }

  async listChannels(): Promise<ChannelsResponse> {
    return this.request<ChannelsResponse>('GET', '/channels');
  }

  async requestUpload(params: {
    fileName: string;
    fileType: string;
    fileSize: number;
  }, signal?: AbortSignal): Promise<UploadRequestResponse> {
    return this.request<UploadRequestResponse>('POST', '/files/upload-request', params, DEFAULT_TIMEOUT_MS, signal);
  }

  /**
   * The stored bytes of `fileKey`, read whole and refused past `maxBytes`. The server hands back a
   * signed address (`GET /files/:key` → `{ downloadUrl }`); that address is the whole source, so a
   * redirect away from it is refused like the upload's.
   */
  async downloadFile(fileKey: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const meta = await this.request<{ data?: { downloadUrl?: unknown } }>('GET', `/files/${encodeURIComponent(fileKey)}`, undefined, DEFAULT_TIMEOUT_MS, signal);
    const url = meta.data?.downloadUrl;
    if (typeof url !== 'string') throw new ApiError('The hwip API gave no download address for the file', 'BAD_RESPONSE', 0);
    const problem = downloadUrlProblem(url, this.baseUrl);
    if (problem) throw new ApiError(`Refused the file's download address: ${problem}`, 'BAD_RESPONSE', 0);
    const { signal: combined, release } = requestSignal(transferTimeoutMs(maxBytes), signal);
    try {
      const response = await fetch(url, { signal: combined, redirect: 'error' }).catch((err: unknown) => {
        throw transportError(err, 'GET') ?? err;
      });
      if (!response.ok) throw new ApiError(`File download failed with status ${response.status}`, 'DOWNLOAD_FAILED', response.status);
      return Buffer.from(await readCapped(response, maxBytes, () => new ApiError(`The file is larger than ${maxBytes} bytes, so it was not read`, 'DOWNLOAD_TOO_LARGE', 413)));
    } finally {
      release();
    }
  }

  async uploadToS3(url: string, content: string | Buffer, contentType: string, signal?: AbortSignal): Promise<void> {
    const isText = typeof content === 'string';
    const body = isText ? content : new Uint8Array(content);
    const bytes = isText ? Buffer.byteLength(content) : content.byteLength;
    const { signal: combined, release } = requestSignal(transferTimeoutMs(bytes), signal);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': uploadContentType(contentType) },
        body,
        signal: combined,
        // The signed address is the whole destination: a redirect would carry the bytes somewhere it did not name.
        redirect: 'error',
      });
    } catch (err) {
      // M41: this address came from the API's own reply (`requestUpload`'s `uploadUrl`), not from the
      // configured base URL — an address that is not one is the server's defect, and must not send the
      // model to correct HWIP_BASE_URL. Its own code, still carrying the transport's cause.
      const transport = transportError(err, 'PUT');
      if (transport?.causeCode === 'ERR_INVALID_URL') {
        throw new ApiError(
          'The hwip API gave an upload address that is not a usable URL, so the file was not uploaded',
          'INVALID_UPLOAD_URL',
          0,
          { unsent: true, causeCode: 'ERR_INVALID_URL' },
        );
      }
      throw transport ?? err;
    } finally {
      release();
    }
    if (!response.ok) {
      throw new ApiError(`S3 upload failed with status ${response.status}`, 'UPLOAD_FAILED', response.status);
    }
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.send<T>(method, path, body ? { body: JSON.stringify(body) } : {}, timeoutMs, signal);
  }

  /** One request, its JSON body already the bytes to send. */
  private async send<T>(
    method: string,
    path: string,
    payload: { body?: string; headers?: Record<string, string> },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      ...(payload.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...payload.headers,
    };

    const { signal: combined, release } = requestSignal(timeoutMs, signal);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload.body,
        signal: combined,
        // A redirect would carry the X-API-Key header to another host.
        redirect: 'error',
      });
    } catch (err) {
      throw transportError(err, method) ?? err;
    } finally {
      release();
    }

    if (!response.ok) {
      // Read the body as text once, then try to parse it. A non-JSON
      // error (HTML proxy page, gateway error) would otherwise be swallowed
      // silently — surface a truncated snippet so failures are debuggable.
      const raw = await readCappedText(response, MAX_ERROR_BODY_BYTES).catch(() => '');
      let errorBody: ApiErrorBody | null = null;
      try {
        errorBody = raw ? (JSON.parse(raw) as ApiErrorBody) : null;
      } catch {
        if (raw) console.error(`[api] ${response.status} non-JSON body: ${sanitizeSmuggled(raw.slice(0, 200).replace(UNPRINTABLE, ' '))}`);
      }
      const message = serverMessage(errorBody?.error?.message, `Request failed with status ${response.status}`);
      const sentCode = errorBody?.error?.code;
      const code = typeof sentCode === 'string' && ERROR_CODE_SHAPE.test(sentCode) ? sentCode : 'UNKNOWN_ERROR';
      throw new ApiError(message, code, response.status);
    }

    try {
      return JSON.parse(await readCappedText(response, MAX_RESPONSE_BYTES)) as T;
    } catch (err) {
      // The reader's own refusal of a reply that is too large.
      if (err instanceof ApiError) throw err;
      // A 2xx that is not the API's JSON: a proxy's page, a body cut short. Status 0, as for any call
      // that got no usable answer: it is one a later call may get past.
      const landedNote = method === 'GET' ? '' : ' The request may still have reached the server.';
      throw new ApiError(`The hwip API's reply could not be read (HTTP ${response.status}).${landedNote}`, 'BAD_RESPONSE', 0);
    }
  }
}
