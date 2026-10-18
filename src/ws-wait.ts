/**
 * WebSocket fast path for hook-response waits (SPEC-AGENT-AWARENESS §S3).
 *
 * The server broadcasts `hook.responded` / `hook.cancelled` the moment
 * the user answers. This module subscribes to that feed so a wait can
 * wake instantly instead of sitting out its poll interval.
 *
 * Trust model: the WS message is a WAKE-UP SIGNAL ONLY. The poll loop
 * remains the single source of truth — on wake it immediately re-reads
 * the event over REST and acts on that. A spoofed/garbled/duplicated
 * frame can therefore cost at most one extra GET, never a wrong answer.
 * The same property makes degradation trivial: no WebSocket global
 * (Node < 22), no wsUrl configured, or a dropped socket all just mean
 * "nobody wakes us early" and the existing poll cadence carries on.
 *
 * Connection lifecycle: lazy connect on first subscribe, shared across
 * concurrent waits, app-level ping every 25 s (API GW $default route
 * answers 'pong'; native WebSocket has no protocol-ping API), closed
 * 30 s after the last pending wait ends. A socket that drops while a wait is
 * pending is opened again after 1 s, doubling to 30 s.
 */

// Minimal structural view of the WHATWG WebSocket — lets tests inject a
// fake without the DOM lib, and prod code use globalThis.WebSocket.
export interface WsLike {
    readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: string, listener: (event: { data?: unknown; }) => void): void;
}

export type WsFactory = (url: string) => WsLike;

const WS_OPEN = 1;
const PING_INTERVAL_MS = 25_000;
const IDLE_CLOSE_MS = 30_000;
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface WaitSubscription {
    /** Resolves when the server says this event settled (answer or cancel). */
    settled: Promise<void>;
    /** Live socket right now? Drives the caller's poll cadence. */
    isConnected(): boolean;
    dispose(): void;
}

export interface HookResponseWaiterOptions {
    wsUrl?: string;
    apiKey: string;
    /** Test seam. Defaults to globalThis.WebSocket when present. */
    factory?: WsFactory;
}

const defaultFactory = (): WsFactory | undefined => {
    const WS = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
    if (!WS) return undefined;
    return (url) => new WS(url);
};

/**
 * A start-up line when hwip_ask cannot be woken over the WebSocket, or null. Without it the
 * fast path is off in silence and every answer waits for the next poll (`poll.ts`).
 */
export const wsFastPathNotice = (wsUrl: string | undefined, hasWebSocket = !!defaultFactory()): string | null => {
    if (!wsUrl) {
        return '[WS] No WebSocket URL for this API — hwip_ask waits by polling. Set "wsUrl" in ~/.hwip/config.json (`hwip login` writes it).';
    }
    if (!hasWebSocket) {
        return `[WS] Node ${process.versions.node} has no WebSocket — hwip_ask waits by polling. Node 22 or later answers at once.`;
    }
    return null;
};

export class HookResponseWaiter {
    private readonly wsUrl?: string;
    private readonly apiKey: string;
    private readonly factory?: WsFactory;
    private sock: WsLike | null = null;
    private connected = false;
    private readonly pending = new Map<string, () => void>();
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    /** Reconnects since the socket was last open: the next one waits 2^n s, up to 30 s. */
    private reconnects = 0;

    constructor(opts: HookResponseWaiterOptions) {
        this.wsUrl = opts.wsUrl;
        this.apiKey = opts.apiKey;
        this.factory = opts.factory ?? defaultFactory();
    }

    /** False when the fast path can't exist — caller skips subscribe(). */
    canWait(): boolean {
        return !!this.wsUrl && !!this.factory;
    }

    subscribe(eventId: string): WaitSubscription {
        let resolveSettled: () => void = () => undefined;
        const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
        this.pending.set(eventId, resolveSettled);
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        this.ensureSocket();
        return {
            settled,
            isConnected: () => this.connected,
            dispose: () => {
                this.pending.delete(eventId);
                if (this.pending.size === 0) this.scheduleIdleClose();
            },
        };
    }

    private ensureSocket(): void {
        if (this.sock || !this.wsUrl || !this.factory) return;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        try {
            const sep = this.wsUrl.includes('?') ? '&' : '?';
            // KNOWN TRADEOFF: apiKey rides the query string — the WHATWG
            // WebSocket (Node 22+ global) can't set headers, and the API GW
            // $connect route authenticates on the query param. It can land in
            // gateway access logs; first-message auth needs a server change.
            const sock = this.factory(`${this.wsUrl}${sep}apiKey=${encodeURIComponent(this.apiKey)}`);
            this.sock = sock;
            sock.addEventListener('open', () => {
                if (this.sock !== sock) return; // stale socket — already replaced
                this.connected = true;
                this.reconnects = 0;
                this.pingTimer = setInterval(() => {
                    try {
                        if (sock.readyState === WS_OPEN) sock.send(JSON.stringify({ type: 'ping' }));
                    } catch { /* socket died mid-send — close handler cleans up */ }
                }, PING_INTERVAL_MS);
                // MCP servers are short-lived child processes; an unref'd
                // timer must not keep one alive after stdio closes.
                (this.pingTimer as { unref?: () => void }).unref?.();
            });
            sock.addEventListener('message', (event) => this.handleMessage(event.data));
            // Guard against stale events: 'error' and 'close' both fire on a
            // dying socket, and a new subscribe() may have already created a
            // replacement between them — a late event from the old socket
            // must not tear down the new one.
            const drop = (): void => {
                if (this.sock !== sock) return;
                this.teardownSocket();
                this.scheduleReconnect();
            };
            sock.addEventListener('close', drop);
            sock.addEventListener('error', drop);
        } catch {
            this.teardownSocket();
        }
    }

    private handleMessage(data: unknown): void {
        if (typeof data !== 'string') return;
        try {
            const msg = JSON.parse(data) as { type?: string; data?: { eventId?: string } };
            if (msg.type !== 'hook.responded' && msg.type !== 'hook.cancelled') return;
            const eventId = msg.data?.eventId;
            if (typeof eventId !== 'string') return;
            // Resolve-and-keep: the poll loop confirms over REST and then
            // disposes; resolving a missing id is a no-op by design.
            this.pending.get(eventId)?.();
        } catch {
            /* non-JSON frame — ignore */
        }
    }

    /** A wait still pending gets its fast path back; the poll loop covers the gap. */
    private scheduleReconnect(): void {
        if (this.pending.size === 0 || this.reconnectTimer) return;
        const delay = Math.min(RECONNECT_FIRST_MS * 2 ** this.reconnects, RECONNECT_MAX_MS);
        this.reconnects += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.pending.size > 0) this.ensureSocket();
        }, delay);
        (this.reconnectTimer as { unref?: () => void }).unref?.();
    }

    private scheduleIdleClose(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.teardownSocket(), IDLE_CLOSE_MS);
        (this.idleTimer as { unref?: () => void }).unref?.();
    }

    private teardownSocket(): void {
        this.connected = false;
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        const sock = this.sock;
        this.sock = null;
        try { sock?.close(); } catch { /* already closed */ }
        // Pending waits stay pending — they simply lose the fast path and
        // their poll loops (which check isConnected) tighten back up.
    }
}
