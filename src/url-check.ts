/**
 * Where the API key may be sent. The key travels in the `X-API-Key` header to
 * `baseUrl` and in the query of the `wsUrl` socket, so both URLs decide who can
 * read it. Same rules as the cli's `wsUrlProblem` (src/ws-url.ts)
 * and `insecureUrlWarning` (src/insecure-url.ts) — keep them in step.
 */

/** Why `url` cannot be a socket URL, or null. Never quotes userinfo, query or fragment: the log may be shared. */
export const wsUrlProblem = (url: unknown): string | null => {
    // Whatever the config file holds: a number or a list is not a URL either.
    if (typeof url !== 'string') return 'the WebSocket URL has to be a string, like "wss://ws.hwip.app"';
    const shown = url.replace(/\/\/[^/@]*@/, '//').replace(/[?#].*$/, '');
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return `the WebSocket URL "${shown}" is not a URL — it needs a scheme, like wss://${shown.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '')}`;
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return `the WebSocket URL "${shown}" must start with ws:// or wss://`;
    }
    // `?apiKey=…` is appended to it: a space or a fragment would break the connection (or put the key in the fragment).
    if (/\s/.test(url)) return `the WebSocket URL "${shown}" has a space in it`;
    if (parsed.hash) return `the WebSocket URL "${shown}" has a #fragment, which a socket URL cannot carry`;
    return null;
};

// `localhost.` (a trailing dot), the unspecified address and its IPv4-mapped loopback form are this machine too.
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\])$/i;

/** Whether `hostname` (from `URL.hostname`) is this machine. */
const isLoopbackHost = (hostname: string): boolean => LOOPBACK.test(hostname.replace(/\.$/, ''));

/** One line of warning for a URL that sends the key in the clear to a non-loopback host, else null. */
export const insecureUrlWarning = (url: string): string | null => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (isLoopbackHost(parsed.hostname)) return null;
    if (parsed.protocol === 'http:') {
        return `[hwip] ${parsed.host} is reached over plain http:// — your API key travels in the clear. Use an https:// base URL.`;
    }
    if (parsed.protocol === 'ws:') {
        return `[hwip] the WebSocket at ${parsed.host} is reached over plain ws:// — your API key travels in the clear. Use a wss:// URL.`;
    }
    return null;
};

/**
 * Why the client will not fetch `url` as a file download, or null when it may — the cli's
 * `downloadUrlProblem` (src/insecure-url.ts), kept in step. The URL comes from the API (`GET /files/<key>`),
 * so a relay that rewrites the reply picks where this machine sends a GET: its loopback services, the cloud
 * metadata address, the LAN. Only S3 over https is a download address; a loopback one only when the API is
 * loopback too (the local server hands out its LocalStack endpoint).
 */
export const downloadUrlProblem = (url: string, baseUrl: string): string | null => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return 'not a URL';
    }
    const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
    if (parsed.protocol === 'https:' && (host === 'amazonaws.com' || host.endsWith('.amazonaws.com'))) return null;
    const apiHost = URL.canParse(baseUrl) ? new URL(baseUrl).hostname : '';
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(host) && isLoopbackHost(apiHost)) return null;
    return `${parsed.protocol}//${parsed.host} is not an S3 download address`;
};
