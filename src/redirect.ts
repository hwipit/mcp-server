/**
 * Every call that carries the API key passes `redirect: 'error'`: undici drops
 * `authorization` and `cookie` when a redirect leaves the origin but sends any
 * other header on, so `X-API-Key` would reach whatever host the answer names.
 * `fetch` then rejects, with the reason somewhere down the cause chain.
 */
export const isRedirectRefusal = (err: unknown): boolean => {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
    if (/unexpected redirect/i.test(e.message)) return true;
  }
  return false;
};
