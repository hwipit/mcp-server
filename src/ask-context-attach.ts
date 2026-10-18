/**
 * The attachment a sealed `hwip_ask` question carries (F3; twin of the cli's `src/ask-context-attach.ts`): the
 * original of the asking session's context — its masked diff and screen — sealed for the devices the question
 * is sealed for. The context itself comes from the `hwip` CLI (`hwip ask-context show`), which owns git, tmux,
 * the masking and the per-project switch; nothing of that is copied here.
 *
 * What the server sees of it is the same for every sealed question: one attachment, named `file`, of type
 * `application/octet-stream`, 64 KiB long. A question with nothing to carry — the switch is off, no change, an
 * older CLI, no CLI at all — gets the same attachment with nothing in it. The real name, type and length are in
 * the sealed body.
 */

import type { HwipApiClient } from './api-client.js';
import type { AskAttachment } from './ask-seal.js';
import { askContext, encryptFileForDevices, type DeviceRecipient, type SealedAskContext } from './crypto.js';
import { execHwip, type ExecHwip } from './tools/agent-local.js';

/** Every attachment is this long before it is sealed: the longest original (the CLI's `ASK_CONTEXT_MAX_BYTES`), so none needs more. */
export const ASK_ATTACHMENT_BYTES = 64 * 1024;
/** What the server is told the attachment is. */
const WIRE_NAME = 'file';
const WIRE_TYPE = 'application/octet-stream';
/** What the sealed body says it is; a reader finds the original by this type. */
const SEALED_NAME = 'ask-context.json';
const SEALED_TYPE = 'application/vnd.hwip.ask-context+json';
/** With less of the question's window left than this, the CLI is not asked: its git and tmux reads may take most of it. */
export const ASK_CONTEXT_MIN_WINDOW_MS = 20_000;
/** What attaching leaves of the question's window, for the question itself to be sent and answered. */
export const ASK_ATTACH_RESERVE_MS = 10_000;
/** A window this short is a choice, not a failure: it is not warned about. */
const NO_ROOM = 'too little of the window left to attach the context';

export interface AskContextOriginal {
  summary: SealedAskContext;
  original: { diff: string; screen: string };
}

/**
 * The original as JSON (`{ diff, screen }`, UTF-8) followed by zero bytes up to `ASK_ATTACHMENT_BYTES`; `size`
 * is where the JSON ends. No context, or an original that does not fit, is all zeros and `size` 0 — and no summary.
 */
export const padAskOriginal = (ctx: AskContextOriginal | null): { bytes: Buffer; size: number; context?: SealedAskContext } => {
  const bytes = Buffer.alloc(ASK_ATTACHMENT_BYTES);
  if (!ctx) return { bytes, size: 0 };
  const text = Buffer.from(JSON.stringify(ctx.original), 'utf-8');
  if (text.length > ASK_ATTACHMENT_BYTES) return { bytes, size: 0 };
  text.copy(bytes);
  return { bytes, size: text.length, context: ctx.summary };
};

/**
 * What `hwip ask-context show` printed, if it is a context this tool can carry: the summary must pass the same
 * reader this server applies to a sealed question's `context` (`askContext`), and the original must be two
 * strings. Anything else — an older CLI's status line included — is `null`.
 */
export const readShownContext = (stdout: string): AskContextOriginal | null => {
  let shown: unknown;
  try {
    shown = JSON.parse(stdout);
  } catch {
    return null;
  }
  const context = (shown as { context?: unknown } | null)?.context;
  if (typeof context !== 'object' || context === null) return null;
  const { summary, original } = context as { summary?: unknown; original?: unknown };
  const read = askContext(summary);
  if (!read || typeof original !== 'object' || original === null) return null;
  const { diff, screen } = original as { diff?: unknown; screen?: unknown };
  if (typeof diff !== 'string' || typeof screen !== 'string') return null;
  return { summary: read, original: { diff, screen } };
};

export interface AttachDeps {
  /** The context to carry, or `null`; a throw counts as `null`. */
  context: () => Promise<AskContextOriginal | null>;
  encrypt: typeof encryptFileForDevices;
  /** Stores the sealed bytes and returns their `fileKey`. */
  upload: (sealed: Buffer) => Promise<string>;
}

/** Seals and uploads the attachment for `recipients`. Throws when sealing or the upload fails. */
export const attachAskContext = async (recipients: DeviceRecipient[], deps: AttachDeps): Promise<AskAttachment> => {
  // No context and a context that failed look the same to the server on purpose; `liveAttach` says which on stderr.
  const padded = padAskOriginal(await deps.context().catch(() => null));
  const sealed = await deps.encrypt(padded.bytes, recipients);
  const fileKey = await deps.upload(sealed.ciphertext);
  return {
    ...(padded.context ? { context: padded.context } : {}),
    meta: { iv: sealed.iv, name: SEALED_NAME, type: SEALED_TYPE, size: padded.size },
    file: { fileKey, fileName: WIRE_NAME, fileType: WIRE_TYPE, fileSize: ASK_ATTACHMENT_BYTES, iv: sealed.iv, deviceKeyMap: sealed.deviceKeyMap },
  };
};

/**
 * `attachAskContext`, given up (it rejects, and the question goes without it) once it would eat into the last
 * `ASK_ATTACH_RESERVE_MS` of a window of `windowMs`: storing the attachment must never hold the question back.
 */
export const attachWithinWindow = (recipients: DeviceRecipient[], deps: AttachDeps, windowMs: number): Promise<AskAttachment> => {
  const room = windowMs - ASK_ATTACH_RESERVE_MS;
  if (room <= 0) return Promise.reject(new Error(NO_ROOM));
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`attaching the context took over ${room} ms`)), room);
  });
  return Promise.race([attachAskContext(recipients, deps), late]).finally(() => clearTimeout(timer));
};

/** The context of the session this server runs in, from the CLI; `null` with too little of the window left to ask it. */
export const collectAskContext = async (exec: ExecHwip, windowMs: number, signal?: AbortSignal): Promise<AskContextOriginal | null> => {
  if (windowMs < ASK_CONTEXT_MIN_WINDOW_MS) return null;
  return readShownContext((await exec(['ask-context', 'show'], signal)).stdout);
};

/**
 * `AskSealDeps.attach` for real use: the context `hwip` reports for this server's directory and tmux pane,
 * sealed with this machine's keys, stored with the account, within the question's `windowMs`. What goes wrong
 * is said on stderr (stdout is the MCP transport): a context that could not be read goes as the empty
 * attachment, one that could not be stored not at all.
 */
export const liveAttach = (
  client: Pick<HwipApiClient, 'requestUpload' | 'uploadToS3'>,
  windowMs: number,
  signal?: AbortSignal,
  exec: ExecHwip = execHwip,
  warn: (line: string) => void = (line) => console.error(`[hwip] ${line}`),
) =>
  (recipients: DeviceRecipient[]): Promise<AskAttachment> => {
    // Stops the CLI and the upload once the attachment is given up on, as well as on the call's cancel.
    const stop = new AbortController();
    const cancelled = () => stop.abort();
    signal?.addEventListener('abort', cancelled, { once: true });
    const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
    return attachWithinWindow(recipients, {
      context: async () => {
        try {
          return await collectAskContext(exec, windowMs, stop.signal);
        } catch (err) {
          // No `hwip` installed is a setup this tool supports: it asks with the empty attachment, unremarked.
          const absent = (err as { code?: unknown } | null)?.code === 'ENOENT';
          if (!absent && !stop.signal.aborted) warn(`the context could not be read from \`hwip ask-context show\` (${message(err)}); the question carries none`);
          return null;
        }
      },
      encrypt: encryptFileForDevices,
      upload: async (sealed) => {
        const upload = await client.requestUpload({ fileName: WIRE_NAME, fileType: WIRE_TYPE, fileSize: sealed.length }, stop.signal);
        await client.uploadToS3(upload.data.uploadUrl, sealed, WIRE_TYPE, stop.signal);
        return upload.data.fileKey;
      },
    }, windowMs).catch((err: unknown) => {
      if (message(err) !== NO_ROOM && !signal?.aborted) warn(`the context was not attached (${message(err)}); the question goes without it`);
      throw err;
    }).finally(() => {
      stop.abort();
      signal?.removeEventListener('abort', cancelled);
    });
  };
