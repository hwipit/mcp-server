/**
 * Sticky REMOTE state — the server's half.
 *
 * REMOTE used to have nowhere to live: the model re-derived it every turn by
 * rescanning the conversation. It now lives in a file, and this module is one
 * of the two places that owns a transition. The other is the plugin's
 * UserPromptSubmit hook, which enters REMOTE when a prompt matches a
 * phone-injection marker; this module handles the transitions the server
 * already knows about — a `hwip_ask` that came back answered.
 *
 * **Three implementations share the file format** — plugin/hooks/gate.sh
 * (`hwip_remote_active` / `hwip_remote_touch`), cli/src/gate.ts
 * (`isRemoteActive` / `touchRemoteActive`), and this file. Nothing checks them
 * against each other at build time, so the format is pinned by literal
 * assertions in remote-state.test.ts. The bash reader sweeps any non-numeric
 * body on sight (`case "$ts" in *[!0-9]*)`), which means a JSON or ISO-8601
 * body written here would enter REMOTE and be deleted by the very next prompt
 * hook — silently, and invisibly from either repo's tests.
 *
 * There is no TTL logic here on purpose: expiry is the readers' job, and
 * duplicating the window would give it two definitions.
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { detectProjectDir, projectHash } from './config.js';

/** Action ids that end a remote session (CORE_RULES: case-insensitive). */
const SESSION_EXIT_IDS = ['done', 'stop', 'exit'] as const;

/**
 * True when this button ends the session. Case-insensitive by contract — the
 * rules have always said so, but until now nothing enforced it, so a skill
 * emitting `Done` would have read as a non-exit answer and left the user in
 * REMOTE for the whole TTL.
 */
export const isSessionExitId = (actionId: string): boolean =>
  (SESSION_EXIT_IDS as readonly string[]).includes(actionId.trim().toLowerCase());

/**
 * What a `hwip_ask` outcome does to the mode.
 *
 * - **exit** — a Done-like id, whether the user tapped it or a timeout
 *   resolved to it (the one case a fallback ends the session), or free text
 *   the user sent with the phone's "send and exit" button (`exitRemote`).
 * - **enter** — the user answered with anything else: another button, or plain
 *   free text. Free text the server cannot judge — "thanks, that's it" is a
 *   meaning call that stays with the model — so it counts as staying, unless
 *   the user marked it with `exitRemote` themselves. A button id outranks that
 *   flag — no client sends both, so the order is only a defence.
 * - **keep** — the ask timed out onto a non-exit fallback. Rule 5 recommends
 *   `wait`/`review` there, and ask.ts returns the fallback id verbatim, so
 *   reading it as an exit would drop a user out of REMOTE over an ask they
 *   simply had not answered yet. Nor is it an entry: a timeout is not a user
 *   action, and a NORMAL session must not become remote because nobody
 *   replied. The mode is left exactly as it was.
 */
export type RemoteTransition = 'enter' | 'exit' | 'keep';

export const remoteTransitionFor = (
  answer: { actionId?: string; exitRemote?: boolean; timedOut: boolean },
): RemoteTransition => {
  if (answer.actionId !== undefined && isSessionExitId(answer.actionId)) return 'exit';
  if (answer.timedOut) return 'keep';
  return answer.actionId === undefined && answer.exitRemote === true ? 'exit' : 'enter';
};

const stateDir = (): string =>
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'hwip');

/** `<stateDir>/remote-active-<projectHash>`, or null when the key can't be built. */
export const remoteStatePath = (): string | null => {
  const hash = projectHash(detectProjectDir());
  return hash ? join(stateDir(), `remote-active-${hash}`) : null;
};

/** Enter REMOTE, or push its expiry back. Best-effort: never throws. */
export const enterRemote = (): void => {
  const file = remoteStatePath();
  if (!file) return;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(file, `${Math.floor(Date.now() / 1000)}\n`);
  } catch {
    /* an answered ask is still an answer — state IO must not reach the caller */
  }
};

/** Leave REMOTE. Best-effort: never throws, and a missing file is success. */
export const exitRemote = (): void => {
  const file = remoteStatePath();
  if (!file) return;
  try {
    unlinkSync(file);
  } catch {
    /* already gone, or unwritable — either way the caller has an answer */
  }
};
