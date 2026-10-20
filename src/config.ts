import { readdirSync, readFileSync, statSync, mkdirSync, openSync, writeSync, closeSync, constants as fsConstants } from 'fs';
import { homedir, hostname } from 'os';
import { randomBytes, createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { insecureUrlWarning, wsUrlProblem } from './url-check.js';

const DEFAULT_BASE_URL = 'https://api.hwip.app/v1';
/** The prod socket, used only with the prod API — the cli listener's rule (cli `src/ws-url.ts`):
 *  with any other base the stage is not known, and the wrong socket would split the agent. */
const DEFAULT_WS_URL = 'wss://ws.hwip.app';

export interface McpServerConfig {
    apiKey: string;
    baseUrl: string;
    /** WebSocket endpoint for the hook-response fast path (§S3). Optional —
     *  without it (or without a WebSocket global) waits are poll-only. */
    wsUrl?: string;
    hookId?: string;
    deviceId?: string;
    sessionId?: string;
    /** Stable agent-session key parts so hook pushes join the session chat:
     *  the listener's per-host device id (mirrors cli computeListenerDeviceId)
     *  + the tmux session name. The Claude sessionId above rotates on
     *  compact/resume; these don't. */
    agentDeviceId?: string;
    agentSessionName?: string;
    /** Last path segment of the project directory — prefixed onto push titles. */
    projectName: string;
    /** `HWIP_AUTONAME` — the agent names its own session (`hwip_session_title`).
     *  Set by the installer only for agents with no title of their own. */
    autoName?: boolean;
}

const PROJECT_DIR_ENV_KEYS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR'] as const;

/**
 * Ceiling on any one command this module shells out to. Start-up waits on all
 * of them, and a wedged tool (a hung tmux server, a stalled ioreg) used to hold
 * the MCP server's start for as long as it hung. A timed-out command throws,
 * which every caller already reads as "not available". Worst case with
 * everything hung: cksum + ioreg + tmux + one ps, since a null `ps` ends the
 * pane-ancestry walk.
 */
const SHELL_OUT_TIMEOUT_MS = 2_000;

/**
 * `ioreg` is the exception: its answer seeds the device id, which must equal the
 * one the cli listener computes. Giving up early would fall back to a different
 * id and unthread `hwip_ask` from the agent chat, so it waits longer than the
 * rest. cli bounds it at the same 5 s (listener-device-id.ts) and falls back the
 * same way, so a stalled ioreg gives both the same hostname-hash id.
 */
const IOREG_TIMEOUT_MS = 5_000;

/** `projectHash` results by directory — the value cannot change within a process. */
const projectHashes = new Map<string, string>();

/** The project directory the agent runs in, across supported agents. */
/**
 * The key every per-project hwip file is named by. Shelling out to `cksum`
 * (rather than a pure-JS CRC) is what guarantees it matches the files the bash
 * hooks have already written — they key off `printf '%s' "$dir" | cksum`. Null
 * when `cksum` is unavailable, which means no per-project file can be resolved.
 */
export const projectHash = (dir: string): string | null => {
    const cached = projectHashes.get(dir);
    if (cached) return cached;
    let hash: string | null = null;
    try {
        hash = execFileSync('cksum', { input: dir, encoding: 'utf-8', timeout: SHELL_OUT_TIMEOUT_MS }).split(' ')[0] || null;
    } catch {
        hash = null;
    }
    // A failure is not cached: it may be a slow start, and every caller retries
    // on the next call, as they always did.
    if (hash !== null) projectHashes.set(dir, hash);
    return hash;
};

export const detectProjectDir = (): string => {
    for (const key of PROJECT_DIR_ENV_KEYS) {
        const val = process.env[key];
        if (val) return val;
    }
    return process.cwd();
};

/** Last path segment of a directory: "/Users/me/code/hwip" -> "hwip". */
const projectNameFromDir = (dir: string): string =>
    dir.split('/').filter(Boolean).pop() ?? 'project';

/**
 * Prefix a push title with the project name so the device feed stays
 * scannable — "hwip · Build finished" instead of a bare "Build finished".
 * Idempotent: a title already carrying the project segment is returned
 * unchanged (guards against double-prefixing on retries).
 */
export const formatPushTitle = (projectName: string, title: string): string => {
    const prefix = `${projectName} · `;
    return title.startsWith(prefix) ? title : prefix + title;
};

interface FileConfig {
    apiKey?: string;
    baseUrl?: string;
    wsUrl?: string;
    hookId?: string;
    deviceId?: string;
}

const resolvedEnv = (key: string): string | undefined => {
    const val = process.env[key];
    return val && !val.startsWith('${') ? val : undefined;
};

/** `~/.hwip/config.json`, and why it gave nothing when it did not: a missing file and one
 *  that does not parse need different fixes, and both used to read as "no API key". */
type FileProblem = { kind: 'missing' } | { kind: 'unreadable' | 'invalid' | 'ignored'; detail: string } | { kind: 'notUtf8' | 'notObject' };

/**
 * Why this machine should not trust the config file as it stands, or null — the
 * rule of the cli's `configModeProblem` (src/config.ts), keep the two in step.
 * The file holds the API key AND says where the key is sent (`baseUrl`, `wsUrl`),
 * so one that another user owns, or that anyone can write, is a way to redirect
 * the key. `refuse`: ignore the file; otherwise only warn. Group access to a file
 * the user owns is not refused: a user-private group (umask 002, a dotfiles
 * checkout) makes every file 664, and ignoring those would stop every session.
 * Root may read what a user owns (sudo). This server only reads the file, so
 * unlike the cli it does not narrow the mode itself.
 */
export const configModeProblem = (
    st: { uid: number; mode: number },
    myUid: number,
    file: string = join(homedir(), '.hwip', 'config.json'),
): { refuse: boolean; why: string } | null => {
    const mode = (st.mode & 0o777).toString(8);
    const envStillWorks = 'HWIP_API_KEY still works';
    if (st.uid !== myUid && myUid !== 0) {
        return { refuse: true, why: `${file} belongs to another user (uid ${st.uid}), so it is being ignored (${envStillWorks})` };
    }
    if (st.mode & 0o002) {
        return { refuse: true, why: `${file} can be written by anyone (mode ${mode}), so it is being ignored — run \`chmod 600 ${file}\` (${envStillWorks})` };
    }
    if (st.mode & 0o064) {
        return { refuse: false, why: `${file} can be reached by other users (mode ${mode}) and holds your API key — run \`chmod 600 ${file}\`` };
    }
    return null;
};

/** Each message once per process: `loadConfig` and `legacyWsEnvNotice` both read the file. */
const toldOnce = new Set<string>();
const sayOnce = (line: string): void => {
    if (toldOnce.has(line)) return;
    toldOnce.add(line);
    console.error(line);
};

/** `configModeProblem` for the file as it is now. A symlinked file (dotfiles) is judged by what it points at. Windows has no owner or mode to read. */
const configFileProblem = (file: string): { refuse: boolean; why: string } | null => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
    try {
        return configModeProblem(statSync(file), process.getuid(), file);
    } catch {
        return null;
    }
};

const loadFileConfig = (): { config: FileConfig; problem?: FileProblem } => {
    const file = join(homedir(), '.hwip', 'config.json');
    let bytes: Buffer;
    try {
        bytes = readFileSync(file);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: {}, problem: { kind: 'missing' } };
        return { config: {}, problem: { kind: 'unreadable', detail: (err as Error).message } };
    }
    const modeProblem = configFileProblem(file);
    if (modeProblem) {
        sayOnce(`[hwip] ${modeProblem.why}.`);
        if (modeProblem.refuse) return { config: {}, problem: { kind: 'ignored', detail: modeProblem.why } };
    }
    // Not decoded leniently: bytes that are not UTF-8 would become U+FFFD and the rest of the file would still
    // parse, key and server address included. Like the cli (`NotUtf8Error`), such a file is not used at all.
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return { config: {}, problem: { kind: 'notUtf8' } };
    }
    // Nothing in it to lose, and what a crash in the cli's old plain write left behind: as the cli reads it, not an error.
    if (text.trim() === '') return { config: {} };
    try {
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { config: {}, problem: { kind: 'notObject' } };
        }
        return { config: parsed as FileConfig };
    } catch (err) {
        return { config: {}, problem: { kind: 'invalid', detail: (err as Error).message } };
    }
};

const FILE = '~/.hwip/config.json';

const noKeyReason = (problem: FileProblem | undefined): string => {
    switch (problem?.kind) {
        case 'missing': return `${FILE} does not exist and HWIP_API_KEY is not set`;
        case 'unreadable': return `${FILE} could not be read (${problem.detail})`;
        // No `detail` for `invalid`: the parser's message can quote the text around the error, key included.
        case 'invalid': return `${FILE} is not valid JSON`;
        case 'notObject': return `${FILE} does not hold a JSON object`;
        case 'notUtf8': return `${FILE} is not valid UTF-8 text`;
        case 'ignored': return problem.detail;
        default: return `${FILE} has no "apiKey"`;
    }
};

/**
 * Why a file that is not used is not used, for the stderr line when the key came from elsewhere: a
 * file dropped in silence takes its `hookId` and `deviceId` with it, and the tool then blames a
 * missing hookId. No `detail`: the parser's message can quote part of the file, key included.
 * `missing` and `ignored` need no line (a file that is not there is normal; `ignored` said its own).
 */
const droppedFileReason = (problem: FileProblem | undefined): string | null => {
    switch (problem?.kind) {
        case 'invalid':
        case 'notObject':
        case 'notUtf8':
            return noKeyReason(problem);
        case 'unreadable': return `${FILE} could not be read`;
        default: return null;
    }
};

const SESSION_UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

const CLAUDE_PROJECT_DIR_MAX = 200;

/**
 * The directory name Claude Code gives a cwd under `~/.claude/projects/`.
 * Copied from the Claude Code 2.1.287 binary (`k` / `Jx`): every character
 * outside `[a-zA-Z0-9]` becomes `-`, so `.`, `_`, spaces, `@` and Hangul all
 * collapse, one `-` per UTF-16 unit. Names past 200 characters are cut and
 * suffixed with `-` plus the base-36 of a Java-style string hash of the cwd.
 * Same rule and test vectors as the cli's `claudeProjectDirName`
 * (cli/src/remote-agents.ts) — keep the two in step.
 */
export const claudeProjectDirName = (cwd: string): string => {
    const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    if (name.length <= CLAUDE_PROJECT_DIR_MAX) return name;
    let hash = 0;
    for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
    return `${name.slice(0, CLAUDE_PROJECT_DIR_MAX)}-${Math.abs(hash).toString(36)}`;
};

/**
 * Detect the Claude Code session ID for `projectDir`. Claude Code writes
 * one transcript per session at
 * `~/.claude/projects/<claudeProjectDirName(projectDir)>/<uuid>.jsonl`. We
 * pick the most recently modified transcript — that's the live session.
 */
const detectClaudeSessionId = (projectDir: string): string | undefined => {
    try {
        const sessionsDir = join(homedir(), '.claude', 'projects', claudeProjectDirName(projectDir));

        let latest: { name: string; mtime: number } | undefined;
        for (const entry of readdirSync(sessionsDir)) {
            const match = SESSION_UUID_RE.exec(entry);
            if (!match) continue;
            const stat = statSync(join(sessionsDir, entry));
            if (!stat.isFile()) continue;
            if (!latest || stat.mtimeMs > latest.mtime) {
                latest = { name: match[1], mtime: stat.mtimeMs };
            }
        }
        return latest?.name;
    } catch {
        return undefined;
    }
};

/**
 * Truthy-env helper — accepts "1", "true", "yes", "on" (case-insensitive).
 */
const envIsTrue = (key: string): boolean => {
    const v = process.env[key];
    if (!v) return false;
    return /^(1|true|yes|on)$/i.test(v.trim());
};

/**
 * Write the resolved session id to a per-user cache file so shell hooks
 * (e.g. plugin/hooks/hwip-stop.sh) can pick it up when their own transcript
 * scrape misses. The previous location was /tmp/hwip-session-<hash>, which
 * on multi-user machines exposed a symlink race — predictable filename,
 * world-writable directory. Living under ~/.cache (or $XDG_CACHE_HOME)
 * removes that — only the owning user can write there. The file is also
 * opened with O_NOFOLLOW so a pre-existing symlink can never redirect us
 * to /etc/passwd or similar.
 *
 * Users can opt out entirely by setting HWIP_DISABLE_SESSION_CACHE=1.
 * Useful for:
 *   - Read-only filesystems (some container runtimes)
 *   - CI runners where ~/.cache isn't persisted anyway, so the write is
 *     pure overhead
 *   - Sandboxed environments where extra filesystem writes trigger audit
 *     noise
 * The shell hook still works without the cache — it primarily extracts
 * the session id from the transcript_path UUID; the cache is just a
 * fallback for older Claude Code versions.
 */
const writeSessionCache = (sessionId: string, projectDir: string): void => {
    if (envIsTrue('HWIP_DISABLE_SESSION_CACHE')) return;
    try {
        const hash = projectHash(projectDir);
        if (!hash) return;
        const cacheDir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'hwip');
        mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        const cachePath = join(cacheDir, `session-${hash}`);
        const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
        const fd = openSync(cachePath, flags, 0o600);
        try {
            writeSync(fd, sessionId);
        } finally {
            closeSync(fd);
        }
    } catch {
        /* best-effort — hook stop script also extracts session id from
         * the transcript path, so failing here is non-fatal. */
    }
};

const warnInsecure = (url: string): void => {
    const warning = insecureUrlWarning(url);
    if (warning) sayOnce(warning);
};

/** `wsUrl` if it can be a socket URL, else undefined after saying why. Plain `ws://` off this machine is allowed, with a warning. */
const usableWsUrl = (wsUrl: unknown): string | undefined => {
    if (wsUrl === undefined || wsUrl === null) return undefined;
    const problem = wsUrlProblem(wsUrl);
    if (problem) {
        sayOnce(`[hwip] ${problem} — it is ignored.`);
        return undefined;
    }
    warnInsecure(wsUrl as string);
    return wsUrl as string;
};

/** `scheme://host[:port]` of a URL, or null when it is not one. Userinfo, path, query and fragment are not part of it. */
const originOf = (url: string): string | null => {
    try {
        const { origin } = new URL(url);
        return origin === 'null' ? null : origin;
    } catch {
        return null;
    }
};

/**
 * Would `fetch` send this as a header value? Its rule, held to a real send in config.test.ts (Node 24.21,
 * 2026-10-14): white space at either end is dropped, and what is left is a tab, printable ASCII or
 * U+0080–U+00FF. A key that fails it fails every call — with an error that quotes it whole when what it
 * has is a NUL, CR or LF (the place and the code point for one past U+00FF, the header's name for any
 * other control character).
 */
const fitsInHeader = (value: string): boolean =>
    !/[^\t\u0020-\u007e\u0080-\u00ff]/.test(value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, ''));

export const loadConfig = (): McpServerConfig => {
    const { config: fileConfig, problem } = loadFileConfig();
    const envKey = resolvedEnv('HWIP_API_KEY');
    const apiKey: unknown = envKey ?? fileConfig.apiKey; // the file's is typed as text, and is whatever its JSON holds

    if (apiKey === undefined || apiKey === null || apiKey === '') {
        throw new Error(`No API key: ${noKeyReason(problem)}. Run \`hwip login\` or \`hwip install\` (both write the file), or set HWIP_API_KEY.`);
    }
    // The file is JSON anyone may have edited: `"apiKey": 12345` is a mistake to name, as a base URL that is one is.
    if (typeof apiKey !== 'string') {
        throw new Error(`${FILE} has an "apiKey" that is not text. Set it again — \`hwip login\` writes the file, or set HWIP_API_KEY.`);
    }
    // M41: white space alone is not a key — it passes `fitsInHeader` (trimmed to nothing, nothing
    // forbidden in nothing) and then fails every call as UNAUTHORIZED. Refused here, naming where.
    if (apiKey.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '') === '') {
        throw new Error(`The API key in ${envKey ? 'HWIP_API_KEY' : FILE} is blank. Set it again — \`hwip login\` writes the file, or set HWIP_API_KEY.`);
    }
    if (!fitsInHeader(apiKey)) {
        // Where it is, never what it is.
        throw new Error(`The API key in ${envKey ? 'HWIP_API_KEY' : FILE} cannot be sent: it has a line break inside it, or a character no key has. Set it again — \`hwip login\` writes the file.`);
    }

    // Where the key goes, decided before anything is written: the cli's `resolveBaseUrl` rule. The file
    // may hold a base URL the key belongs to (staging, self-hosted), and one that cannot be read must not
    // send an environment key to the default API instead. A file ignored for its mode is not trusted for
    // a base URL on purpose, and the default stands. (The mode is only read after the file was, so a file nobody can read is
    // stopped on rather than ignored: the stricter side of the same rule.)
    const envBase = resolvedEnv('HWIP_BASE_URL');
    if (!envBase && (problem?.kind === 'invalid' || problem?.kind === 'notUtf8' || problem?.kind === 'notObject' || problem?.kind === 'unreadable')) {
        throw new Error(`${noKeyReason(problem)}, so the API base URL it may hold is unknown — fix it, or move it aside, or set HWIP_BASE_URL.`);
    }
    if (!envBase && fileConfig.baseUrl !== undefined && typeof fileConfig.baseUrl !== 'string') { // null too, as in the cli
        throw new Error(`${FILE} has a "baseUrl" that is not text, so where the key goes is unknown — fix it, or set HWIP_BASE_URL.`);
    }
    // M29: a key from the config file belongs to the addresses the file says (its `baseUrl`, else the default API).
    // An address from the environment is not where it was issued for — an `export` in a shell profile, a project's
    // env block — so the file's key does not follow it; the key given in the environment too, or the same origin, does.
    const fileKeyHome = typeof fileConfig.baseUrl === 'string' && fileConfig.baseUrl ? fileConfig.baseUrl : DEFAULT_BASE_URL;
    // An address with no origin (not a URL, `data:`) is not the same as anything, another such one included.
    if (!envKey && envBase && (originOf(envBase) === null || originOf(envBase) !== originOf(fileKeyHome))) {
        throw new Error(
            `HWIP_BASE_URL points at ${originOf(envBase) ?? 'something that is not a URL'}, but the API key in ${FILE} belongs to ` +
            `${originOf(fileKeyHome) ?? 'an address it cannot read'}, so it is not sent there — set HWIP_API_KEY as well, or unset HWIP_BASE_URL.`,
        );
    }
    const dropped = droppedFileReason(problem);
    if (dropped) sayOnce(`[hwip] ${dropped}, so it is being ignored.`);

    const projectDir = detectProjectDir();
    // Claude Code names the running session outright; take it over the
    // transcript scan, which picks the newest file in the project directory and
    // so returns a sibling agent's id whenever two run in one project — the
    // server then threads this session's pushes into the neighbour's chat.
    const sessionId =
        resolvedEnv('HWIP_SESSION_ID') ??
        resolvedEnv('CLAUDE_CODE_SESSION_ID') ??
        detectClaudeSessionId(projectDir) ??
        `sess_${randomBytes(12).toString('base64url')}`;
    writeSessionCache(sessionId, projectDir);

    // `||`, as the cli's resolveBaseUrl: an empty "baseUrl" is no URL and the default stands.
    const baseUrl = (envBase || fileConfig.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    warnInsecure(baseUrl);
    // The socket URL carries the key in its query, so the same rule holds for the one the environment can still supply.
    let envWs = fileConfig.wsUrl === undefined ? legacyWsEnv() : undefined;
    if (envWs !== undefined && !envKey && !(baseUrl === DEFAULT_BASE_URL && originOf(envWs) === originOf(DEFAULT_WS_URL))) {
        sayOnce(`[hwip] HWIP_WS_URL is not used: the API key in ${FILE} is not sent to an address from the environment — set HWIP_API_KEY as well, or put "wsUrl" in ${FILE}.`);
        envWs = undefined;
    }
    return {
        apiKey,
        baseUrl,
        // Config first, environment second — the inverse of what this used to
        // be. `HWIP_WS_URL` sat ABOVE ~/.hwip/config.json, so an `export` in a
        // shell profile silently outranked the file with nothing anywhere to
        // say it had. It still answers when the file has nothing, so a
        // self-hosted machine does not quietly lose its WebSocket fast path.
        // A value that is not a socket URL is told and skipped, not carried into `new WebSocket`.
        // The file wins whole: a bad value there is not handed to the environment's export,
        // which `legacyWsEnvNotice` has just told the user does nothing.
        wsUrl: (fileConfig.wsUrl !== undefined ? usableWsUrl(fileConfig.wsUrl) : usableWsUrl(envWs))
            ?? (baseUrl === DEFAULT_BASE_URL ? DEFAULT_WS_URL : undefined),
        hookId: resolvedEnv('HWIP_HOOK_ID') ?? fileConfig.hookId,
        deviceId: resolvedEnv('HWIP_DEVICE_ID') ?? fileConfig.deviceId,
        sessionId,
        agentDeviceId: listenerDeviceId(),
        agentSessionName: detectTmuxSessionName(),
        projectName: projectNameFromDir(projectDir),
        autoName: envIsTrue('HWIP_AUTONAME'),
    };
};

const LISTENER_ID_FILE = join(homedir(), '.hwip', 'listener-device-id');

const hashListenerId = (seed: string): string =>
    `dev_listener_${createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;

/** ioreg by its absolute path: /usr/sbin is not on every PATH (an IDE or hook environment),
 *  and a failed lookup falls back to a hostname hash — another device id for the same Mac. */
const IOREG = '/usr/sbin/ioreg';

/** Platform machine id (macOS IOPlatformUUID / Linux machine-id), or null.
 *  Mirrors cli `readMachineId` so the hash below matches the listener's id. */
const readMachineId = (): string | null => {
    try {
        if (process.platform === 'darwin') {
            const out = execFileSync(IOREG, ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf-8', timeout: IOREG_TIMEOUT_MS });
            const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
            if (m) return m[1];
        }
        if (process.platform === 'linux') {
            for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
                try {
                    const v = readFileSync(p, 'utf-8').trim();
                    if (v) return v;
                } catch { /* try next path */ }
            }
        }
    } catch { /* no machine id readable — fall through */ }
    return null;
};

/** Listener device id — MUST match cli `computeListenerDeviceId` so `hwip_ask`
 *  hooks land under the same agent-session key as the listener's
 *  agent.command/state pushes (otherwise they reach the feed but never thread
 *  into the agent chat). cli hashes the platform machine id first and falls
 *  back to a hostname hash pinned in a sticky file; mirror that order, reading
 *  (never writing) the file so both processes resolve the same id. */
export const listenerDeviceId = (): string => {
    const machineId = readMachineId();
    if (machineId) return hashListenerId(machineId);
    try {
        const saved = readFileSync(LISTENER_ID_FILE, 'utf-8').trim();
        if (/^dev_listener_[0-9a-f]{8}$/.test(saved)) return saved;
    } catch { /* no sticky file — fall back to hostname */ }
    return hashListenerId(hostname());
};

/** How far up the process tree the pane search walks. A pane's agent spawns
 *  this server as a child or grandchild; more hops than this means the match
 *  would be some unrelated ancestor, not the pane running the agent. */
const PANE_ANCESTRY_HOPS = 8;

/** `ps` for one pid's parent, or null at the top of the tree (or on error). */
const parentPid = (pid: number, run: CommandRunner): number | null => {
    const out = run('ps', ['-o', 'ppid=', '-p', String(pid)]);
    const parsed = Number(out?.trim());
    return Number.isInteger(parsed) && parsed > 1 ? parsed : null;
};

/** Shells out; returns null instead of throwing so every caller reads as one
 *  expression. */
export type CommandRunner = (cmd: string, args: string[]) => string | null;

const liveRunner: CommandRunner = (cmd, args) => {
    try {
        return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: SHELL_OUT_TIMEOUT_MS });
    } catch {
        return null;
    }
};

/**
 * The tmux session whose pane is an ancestor of this process, for an agent that
 * spawns its MCP servers with a sanitized environment.
 *
 * Codex CLI does exactly that — measured 2026-09-14, codex-cli 0.154.0: the
 * `hwip mcp` child it starts inside a tmux pane has only HOME/PATH/LANG/TERM/
 * USER/SHELL/TMPDIR/LOGNAME, no TMUX, and `shell_environment_policy.inherit=all`
 * does not change it (that policy governs its shell tool, not MCP spawns). The
 * env check alone therefore reported "not in tmux" for a session plainly running
 * in one, the push lost its session key, and the phone opened the plain push
 * screen instead of the agent chat with its live terminal.
 *
 * The pane's own pid IS in the tree, so ask tmux which pids own panes and walk
 * up from here until one matches.
 */
const tmuxSessionByPaneAncestry = (run: CommandRunner): string | undefined => {
    const panes = run('tmux', ['list-panes', '-a', '-F', '#{pane_pid} #S']);
    if (!panes) return undefined;
    const sessionByPanePid = new Map<number, string>();
    for (const line of panes.split('\n')) {
        const [pid, ...rest] = line.trim().split(' ');
        const name = rest.join(' ').trim();
        if (pid && name) sessionByPanePid.set(Number(pid), name);
    }

    let pid: number | null = process.pid;
    for (let hop = 0; hop < PANE_ANCESTRY_HOPS && pid !== null; hop += 1) {
        const name = sessionByPanePid.get(pid);
        if (name) return name;
        pid = parentPid(pid, run);
    }
    return undefined;
};

/** The tmux session name the agent runs in (`hwip-<project>`) — stable half of
 *  the session key. Undefined outside tmux; the hook then stays feed-only. */
export const detectTmuxSessionName = (run: CommandRunner = liveRunner): string | undefined => {
    if (process.env.TMUX) {
        const name = run('tmux', ['display-message', '-p', '#S'])?.trim();
        if (name) return name;
    }
    return tmuxSessionByPaneAncestry(run);
};

/**
 * A one-line notice for a machine that still exports `HWIP_WS_URL`, or null.
 *
 * The variable is no longer read. Dropping it in silence would repeat the
 * failure it caused — a value that looks like it is in effect while something
 * else decides — so it is read here only to say it is being ignored.
 */
export const legacyWsEnv = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
    const value = env.HWIP_WS_URL;
    // Same guard resolvedEnv applies: an unexpanded "${HWIP_WS_URL}" out of an
    // agent's env block is a placeholder, not a value.
    return value && !value.startsWith('${') ? value : undefined;
};

/**
 * What to tell a machine that still exports `HWIP_WS_URL`, or null. Two
 * messages, because the two situations differ: an export beside a config file
 * is dead weight, while an export on its own is still carrying the value.
 */
export const legacyWsEnvNotice = (
    // The file's own value, not the resolved one: that is the export's when the file has none.
    fileConfig: { wsUrl?: string } = loadFileConfig().config,
    env: NodeJS.ProcessEnv = process.env,
): string | null => {
    if (!legacyWsEnv(env)) return null;
    return fileConfig.wsUrl
        ? '[Config] HWIP_WS_URL is set but ~/.hwip/config.json wins now — the export does nothing and can go.'
        : '[Config] HWIP_WS_URL is deprecated and will stop being read — move the value to "wsUrl" in ~/.hwip/config.json.';
};
