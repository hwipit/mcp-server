/**
 * Unit pins for isRedirectRefusal: the depth cap and message match that decide
 * whether the X-API-Key bearer keeps refusing after a redirect. The live 307
 * path is covered by keyed-fetch-redirect.test.ts; these guard the parser.
 */
import { describe, expect, it } from 'vitest';
import { isRedirectRefusal } from './redirect.js';

const redirect = (message = 'unexpected redirect', cause?: unknown): Error => {
  const err = new Error(message);
  if (cause !== undefined) (err as { cause?: unknown }).cause = cause;
  return err;
};

const nest = (depth: number, message = 'unexpected redirect'): Error => {
  let err: Error = redirect(message);
  for (let i = 1; i < depth; i++) err = redirect(message, err);
  return err;
};

/** Chain of messages, outermost first. */
const chain = (messages: string[]): Error => {
  let err: Error = redirect(messages[messages.length - 1]);
  for (let i = messages.length - 2; i >= 0; i--) err = redirect(messages[i], err);
  return err;
};

describe('isRedirectRefusal', () => {
  it('matches a direct refusal', () => {
    expect(isRedirectRefusal(redirect())).toBe(true);
  });

  it('walks a short cause chain', () => {
    expect(isRedirectRefusal(new TypeError('fetch failed', { cause: redirect() }))).toBe(true);
  });

  it('stops at the depth cap', () => {
    // A match at depths 0–3 is seen; a match only at depth 4 is not.
    expect(isRedirectRefusal(chain(['fetch failed', 'fetch failed', 'fetch failed', 'fetch failed', 'unexpected redirect']))).toBe(false);
    expect(isRedirectRefusal(chain(['fetch failed', 'fetch failed', 'fetch failed', 'unexpected redirect']))).toBe(true);
  });

  it('stops at a non-Error link', () => {
    expect(isRedirectRefusal(redirect('fetch failed', 'unexpected redirect'))).toBe(false);
  });

  it('rejects a non-matching TypeError', () => {
    expect(isRedirectRefusal(new TypeError('fetch failed'))).toBe(false);
    expect(isRedirectRefusal('unexpected redirect')).toBe(false);
  });
});
