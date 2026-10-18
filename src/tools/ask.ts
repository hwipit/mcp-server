import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HwipApiClient } from '../api-client.js';
import { textResult, errorResult, hookNotConfiguredError, formatToolError } from '../error-format.js';
import { notingKeyChanges } from '../key-changes.js';
import { AskError, pollForResponse } from '../poll.js';
import { formatPushTitle, type McpServerConfig } from '../config.js';
import type { HookResponseWaiter } from '../ws-wait.js';
import { sanitizeText, recoverActions, STYLES, UNKNOWN_STYLE } from '../sanitize.js';
import { enterRemote, exitRemote, isSessionExitId, remoteTransitionFor } from '../remote-state.js';
import { cryptoReady, getKeyPair, getPublicKey } from '../crypto.js';
import { listenerDeviceId } from '../config.js';
import { TRUST_PATH } from '../trust-pins.js';
import { openAnswer, prepareAsk, refusalMessage, type AskSealDeps, type OpenedAnswer } from '../ask-seal.js';
import { liveAttach } from '../ask-context-attach.js';
import { NO_APP_DEVICE } from '../push-audience.js';
import { registerOverClient } from '../self-register.js';

/**
 * Apply the mode transition this answer implies, and tell the model where it
 * landed. The state itself lives in a file the prompt hooks also read, so the
 * two carriers agree without either re-deriving REMOTE from the transcript.
 *
 * `hwipState` is reported only when the server actually decided something. A
 * timeout onto a safe fallback changes nothing, and naming a state there would
 * mean re-reading the file — a fourth parser of a format three already share,
 * to answer a question the server was not asked.
 */
const settleRemoteState = (
  answer: { actionId?: string; exitRemote?: boolean; timedOut: boolean },
): { hwipState?: 'REMOTE' | 'NORMAL' } => {
  switch (remoteTransitionFor(answer)) {
    case 'exit':
      exitRemote();
      return { hwipState: 'NORMAL' };
    case 'enter':
      enterRemote();
      return { hwipState: 'REMOTE' };
    case 'keep':
      return {};
  }
};

/** The seal's world for this server: the account API, this machine's keys, the listener's trust file. */
export const sealDepsFor = (client: Pick<HwipApiClient, 'listDevices' | 'registerDeviceKey'>, config: McpServerConfig): AskSealDeps => ({
  // The server connects before crypto has started (index.ts): the first ask waits here.
  loadKeys: async () => {
    await cryptoReady();
    if (!getKeyPair() || !getPublicKey()) throw new Error('device keys not loaded');
  },
  self: () => {
    const publicKey = getPublicKey();
    return publicKey ? { deviceId: listenerDeviceId(), publicKey } : null;
  },
  listDevices: async () => {
    const devices: unknown = (await client.listDevices()).data;
    if (!Array.isArray(devices)) throw new Error('devices: unexpected response');
    return devices as { deviceId: string; publicKey?: string; type?: string }[];
  },
  register: registerOverClient(client),
  trustPath: TRUST_PATH,
});

const sealedRefusal = (cause: Parameters<typeof refusalMessage>[0], why?: Parameters<typeof refusalMessage>[1]): CallToolResult =>
  errorResult({
    error: cause === 'no-app' ? NO_APP_DEVICE : 'SEALED_ASK_FAILED',
    message: refusalMessage(cause, why),
    suggestion: 'Nothing was sent in the clear. Fix what the message names, or ask in this chat instead and use hwip_notify if the user should be pinged.',
  });

/** Said when an ask ends unanswered after its question went up on a retry, unless the server said the phone was notified. */
const UNCONFIRMED_NOTIFY = 'The question went up on a retry, and the server did not say the phone was notified: it is in the app either way.';

/** A device list or trust file that fails to load may load a moment later: a few reads before giving up. */
const OPEN_ATTEMPTS = 3;
const OPEN_RETRY_MS = 1_000;

const openWithRetry = async (
  response: Parameters<typeof openAnswer>[0],
  askId: string,
  offered: string[] | undefined,
  deps: AskSealDeps,
): Promise<OpenedAnswer> => {
  // Opening needs this machine's key pair: waited for here as well as before the question went out.
  try {
    await deps.loadKeys();
  } catch {
    return { ok: false, cause: 'answer-keystore' };
  }
  for (let attempt = 1; ; attempt++) {
    const opened = await openAnswer(response, askId, offered, deps);
    if (opened.ok || opened.cause !== 'peer-unusable' || attempt >= OPEN_ATTEMPTS) return opened;
    await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS));
  }
};

export const registerAskTool = (server: McpServer, client: HwipApiClient, config: McpServerConfig, waiter?: HookResponseWaiter) => {
  server.registerTool(
    'hwip_ask',
    {
      description:
        'Ask the user a question on their phone: quick-reply buttons plus a text field — they tap or type. Pass `actions` (2–4 buttons) unless the answer is free-form text. Blocks until they answer or `timeout` passes. Requires HWIP_HOOK_ID. The question and the answer always go under end-to-end encryption, with this session\'s masked diff and screen; one that cannot be sealed is refused, never sent in the clear. Needs the Hwip app signed in on an iPhone or Android phone.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        title: z.string().describe('Question or request title'),
        body: z.string().optional().describe('Context or instructions'),
        actions: z
          .array(
            z.object({
              id: z.string().describe('Unique action identifier'),
              label: z.string().describe('Display label for the button'),
              style: z.enum(STYLES).default('secondary')
                .describe('Button style (default: secondary)'),
            }),
          )
          .min(1)
          .max(4)
          .optional()
          .describe('Quick-reply buttons (1-4). Expected on nearly every ask — the phone steers by tapping, so put the next-step candidates here (next command, review, stop) plus a Done-like fallback. Omit ONLY when the answer is inherently free-form text; never omit on a "done — what next?" ask.'),
        placeholder: z.string().optional().describe('Input field placeholder hint'),
        inputType: z
          .enum(['text', 'multiline'])
          .default('text')
          .describe('Input field type (default: text)'),
        timeout: z
          .number()
          .min(10)
          .max(600)
          .default(300)
          .describe('Seconds to wait for response once the question is up (default: 300); a send that fails and is repeated adds its own time before that. Silence returns `timedOut: true`, with `actionId` set to `fallback` when given'),
        fallback: z
          .string()
          .optional()
          .describe('Action ID to auto-select on timeout — one of `actions`, or done/stop/exit to end the loop. Never a `danger` action: silence must not choose it'),
      },
    },
    notingKeyChanges(async ({ title, body, actions, placeholder, inputType, timeout, fallback }, ctx): Promise<CallToolResult> => {
      if (!config.hookId) return hookNotConfiguredError();

      try {
        const pushTitle = formatPushTitle(config.projectName, title);

        // Defend against malformed tool calls where the actions array leaked
        // into the body (a mis-closed `body` parameter). Recover the actions
        // from the raw body first, then strip the leaked markup. Without this
        // the push arrives with no buttons and raw markup in the text.
        const effectiveActions = actions && actions.length > 0 ? actions : recoverActions(body);
        // Leaked buttons skipped the schema. One with a style that is none is refused here as it would
        // have been there: dropped, the question would go out with no buttons and no word of why.
        if (effectiveActions === UNKNOWN_STYLE) {
          return errorResult({
            error: 'INVALID_INPUT',
            message: `an action has a style that is not one of ${STYLES.join(', ')}`,
            suggestion: `Send the call again with each action's style one of ${STYLES.join(', ')}, or left out`,
          });
        }
        const cleanBody = sanitizeText(body);

        // A fallback is the one answer nobody gave, so it is never a `danger` button — checked first,
        // whatever the id: one named `stop` would otherwise pass below as a Done-like id. Those are read
        // without their case or the space around them (isSessionExitId), so the ids are compared that way.
        const spelling = (id: string): string => id.trim().toLowerCase();
        if (fallback !== undefined && effectiveActions?.some((a) => a.style === 'danger' && spelling(a.id) === spelling(fallback))) {
          return errorResult({
            error: 'INVALID_FALLBACK',
            message: `fallback "${fallback}" is a danger action: a timeout would choose it with nobody having answered`,
            suggestion: 'Set fallback to an action that is safe to take unasked, or to a done/stop/exit that is not a danger button, or leave it out',
          });
        }

        // A fallback is either one of the buttons the user saw, or a Done-like
        // exit id (done/stop/exit, any case): the REMOTE contract's way for an
        // unanswered ask to end the loop quietly, on a text-only ask too.
        // Anything else is a typo that would come back as an answer the user
        // never saw.
        if (fallback !== undefined && !isSessionExitId(fallback) && !effectiveActions?.some((a) => a.id === fallback)) {
          const ids = effectiveActions?.map((a) => a.id).join(', ');
          return errorResult({
            error: 'INVALID_FALLBACK',
            message: `fallback "${fallback}" is neither an action id${ids ? ` (${ids})` : ''} nor done/stop/exit`,
            suggestion: 'Set fallback to an action id or to done/stop/exit, or leave it out',
          });
        }

        // The seal is settled before anything is built: a refusal ends it here, unsent.
        const signal = ctx.signal;
        const abortedBeforeSend = () => new AskError('ABORTED', 'The tool call was cancelled before the question was sent', '');
        // The context is made only once the question is being sealed, inside the window the question has.
        const sealDeps: AskSealDeps = { ...sealDepsFor(client, config), attach: liveAttach(client, timeout * 1000, signal) };
        // The lookups (keys, device list) take their own time: a cancel does not wait for them. They run on
        // unobserved, which sends nothing.
        const prepared = await Promise.race([
          prepareAsk({ title: pushTitle, body: cleanBody, actions: effectiveActions, placeholder }, sealDeps),
          new Promise<never>((_, reject) => {
            if (signal?.aborted) reject(abortedBeforeSend());
            signal?.addEventListener('abort', () => reject(abortedBeforeSend()), { once: true });
          }),
        ]);
        if (prepared.kind === 'refused') return sealedRefusal(prepared.cause, prepared.why);

        if (signal?.aborted) throw abortedBeforeSend();

        // A sealed ask gives the server each button's id and style, and nothing of the wording.
        const question = {
          isEncrypted: true as const,
          ...prepared.fields,
          actions: effectiveActions?.map(({ id, style }) => ({ id, ...(style === undefined ? {} : { style }) })),
          metadata: { inputType },
          ...(prepared.files ? { files: prepared.files } : {}),
        };
        // A send that fails in a way that may pass is repeated while the question's window lasts (api-client.ts).
        // Each repeat is a progress notification: a client that keeps the call alive on progress would otherwise
        // sit through the tries hearing nothing, and drop a question that is about to go up.
        let retries = 0;
        const progressToken = ctx._meta?.progressToken;
        const onRetry = async (tries: number): Promise<void> => {
          retries = tries;
          if (progressToken === undefined) return;
          await ctx.sendNotification({
            method: 'notifications/progress',
            // Progress may only rise, and the wait that follows counts seconds from 5 up (poll.ts): the tries stay under that.
            params: { progressToken, progress: tries / 100, total: timeout, message: 'Sending the question again…' },
          });
        };
        const trigger = await client.triggerHook(config.hookId, {
          ...question,
          timeout,
          fallback,
          hookType: 'combo',
          // Lets the phone offer "send and exit" on this ask. The approval gate
          // (cli `hwip ask`) shares the hook type but has no mode to end.
          acceptsExit: true,
          sessionId: config.sessionId,
          agentDeviceId: config.agentDeviceId,
          agentSessionName: config.agentSessionName,
        }, signal, { withinMs: timeout * 1000, onRetry }).catch((err: unknown) => {
          // The POST was already on its way: the server may have created the
          // question even though this call never heard back.
          if (signal?.aborted) {
            throw new AskError('ABORTED', 'The tool call was cancelled while the question was being sent — it may still have reached the phone', '');
          }
          throw err;
        });

        // A repeat the server had already taken is answered with the question's ids alone (hwip
        // `server/src/functions/hooks.ts`, `once.replayed`, read 2026-10-14): the push went out with the first
        // request or not at all, and only that request's answer said which.
        const unconfirmed = retries > 0 && trigger.data.notified !== true ? { notice: UNCONFIRMED_NOTIFY } : {};

        const event = await pollForResponse(
          client,
          config.hookId,
          trigger.data.eventId,
          timeout,
          ctx,
          waiter,
        );

        if (!event) {
          if (fallback) {
            return textResult({
              actionId: fallback,
              timedOut: true,
              ...settleRemoteState({ actionId: fallback, timedOut: true }),
              ...unconfirmed,
            });
          }
          // Same shape as the fallback case, not an error: silence is an
          // outcome, and an error invites the agent to ask again at once.
          return textResult({
            timedOut: true,
            message: `No answer within ${timeout} seconds. The user may be away — do not repeat the question right away.`,
            ...unconfirmed,
          });
        }

        // The plaintext fields of a response to a sealed question are never read: the server
        // refuses them, so any that are there were put there by something else.
        const opened = await openWithRetry(event.data.response, prepared.askId, prepared.offered, sealDeps);
        if (!opened.ok) return sealedRefusal(opened.cause);
        if (opened.actionId !== undefined) {
          return textResult({
            actionId: opened.actionId,
            timedOut: false,
            ...settleRemoteState({ actionId: opened.actionId, timedOut: false }),
          });
        }
        return textResult({
          value: opened.value ?? '',
          timedOut: false,
          ...settleRemoteState({ exitRemote: opened.exit, timedOut: false }),
        });
      } catch (err) {
        return formatToolError(err);
      }
    }),
  );
};
