import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enterRemote,
  exitRemote,
  isSessionExitId,
  remoteStatePath,
  remoteTransitionFor,
} from './remote-state.js';

// The state file is a three-way contract — plugin/hooks/gate.sh, cli/src/gate.ts
// and this module all read and write it, and no build step can check them
// against each other. So the shape is asserted against literals here, never
// against our own writer: a body this module round-trips happily but bash
// sweeps (anything non-numeric) would enter REMOTE and be deleted by the very
// next prompt hook, silently and invisibly from either repo's tests.

let TMP: string;
let savedState: string | undefined;
let savedProjectDir: string | undefined;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'hwip-remote-state-'));
  savedState = process.env.XDG_STATE_HOME;
  savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.XDG_STATE_HOME = join(TMP, 'state');
  process.env.CLAUDE_PROJECT_DIR = TMP;
});

afterEach(() => {
  if (savedState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedState;
  if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  rmSync(TMP, { recursive: true, force: true });
});

describe('remote-state: the file the hooks also read', () => {
  it('keys the file exactly as the bash hooks do', () => {
    const cksum = execFileSync('cksum', { input: TMP, encoding: 'utf-8' }).split(' ')[0];
    expect(remoteStatePath()).toBe(join(TMP, 'state', 'hwip', `remote-active-${cksum}`));
  });

  it('writes a bare epoch second — the only body bash will not sweep', () => {
    enterRemote();
    const body = readFileSync(remoteStatePath()!, 'utf-8');
    expect(body).toMatch(/^\d+\n$/);
    // Sanity that it is a plausible "now", not a constant.
    expect(Number(body.trim())).toBeGreaterThan(1_700_000_000);
  });

  it('exitRemote removes the file', () => {
    enterRemote();
    exitRemote();
    expect(existsSync(remoteStatePath()!)).toBe(false);
  });

  it('exitRemote on a session that was never remote is a no-op', () => {
    expect(() => exitRemote()).not.toThrow();
  });

  it('re-entering refreshes rather than duplicating', () => {
    enterRemote();
    const first = readFileSync(remoteStatePath()!, 'utf-8');
    enterRemote();
    expect(readFileSync(remoteStatePath()!, 'utf-8').length).toBe(first.length);
  });

  it('never throws when the state dir cannot be written', () => {
    // A read-only parent makes both mkdir and write fail. State IO must never
    // reach the caller: hwip_ask has an answer to return either way.
    const locked = join(TMP, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'hwip'), 'not a directory');
    process.env.XDG_STATE_HOME = locked;
    expect(() => enterRemote()).not.toThrow();
    expect(() => exitRemote()).not.toThrow();
  });
});

describe('remote-state: exit signals', () => {
  // CORE_RULES: "action id matching done/stop/exit (case-insensitive)". Until
  // now nothing enforced that — a skill emitting `Done` would have been read
  // as a non-exit answer and left the user asked for the whole TTL.
  it.each(['done', 'stop', 'exit', 'Done', 'STOP', 'ExIt'])('%j ends the session', (id) => {
    expect(isSessionExitId(id)).toBe(true);
  });

  it.each(['wait', 'review', 'continue', 'done-later', 'undone', ''])(
    '%j does not',
    (id) => {
      expect(isSessionExitId(id)).toBe(false);
    },
  );

  it('a free-text answer (no action id) counts as staying remote', () => {
    expect(remoteTransitionFor({ timedOut: false })).toBe('enter');
  });

  it('a non-exit button counts as staying remote', () => {
    expect(remoteTransitionFor({ actionId: 'review', timedOut: false })).toBe('enter');
  });

  // The phone's "send and exit" button: the user marked the text themselves,
  // so there is no meaning call left for the model to make.
  it('free text sent with exitRemote ends the session', () => {
    expect(remoteTransitionFor({ exitRemote: true, timedOut: false })).toBe('exit');
  });

  // No client sends both, so this is only a defence: a button id is the more
  // specific signal, and it keeps deciding exactly as it did before.
  it('a button id outranks exitRemote', () => {
    expect(remoteTransitionFor({ actionId: 'review', exitRemote: true, timedOut: false })).toBe('enter');
  });

  // Rule 5 recommends `wait`/`review` as safe timeout fallbacks, and ask.ts
  // returns the fallback id verbatim. Reading every fallback as an exit would
  // drop the user out of REMOTE over an ask they had not answered yet.
  it('a Done-like fallback ends the session', () => {
    expect(remoteTransitionFor({ actionId: 'done', timedOut: true })).toBe('exit');
  });

  // And the mirror mistake: a timeout is not a user action, so it must not be
  // able to put a NORMAL session into REMOTE either. Neither direction — the
  // mode is left exactly as it was.
  it('a safe fallback leaves the mode untouched', () => {
    expect(remoteTransitionFor({ actionId: 'wait', timedOut: true })).toBe('keep');
  });
});
