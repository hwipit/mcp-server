import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test scopes HOME / cwd / env to a freshly-created temp dir so the
// real ~/.hwip and ~/.cache/hwip never get touched. We snapshot the
// originals key-by-key (not by reassigning process.env, which detaches
// the JS object from the native getenv() Node uses for os.homedir).

const HWIP_ENV_KEYS = [
    'HOME', 'HWIP_API_KEY', 'HWIP_HOOK_ID', 'HWIP_BASE_URL', 'HWIP_WS_URL',
    'HWIP_DEVICE_ID', 'HWIP_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HWIP_DISABLE_SESSION_CACHE',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_PROJECT_DIR',
    'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of HWIP_ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'mcp-config-test-'));
    for (const key of HWIP_ENV_KEYS) delete process.env[key];
    process.env.HOME = TMP;
    vi.resetModules();
});

afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
    for (const key of HWIP_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

const writeFileConfig = (data: Record<string, unknown>): void => {
    const dir = join(TMP, '.hwip');
    mkdirSync(dir, { recursive: true });
    // 0600 like `hwip login` writes it: the default 0644 now earns a warning.
    writeFileSync(join(dir, 'config.json'), JSON.stringify(data), { mode: 0o600 });
};

describe('loadConfig', () => {
    it('throws when no api key is anywhere, naming the file it looked for', async () => {
        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/No API key: ~\/\.hwip\/config\.json does not exist and HWIP_API_KEY is not set\. Run `hwip login`/);
    });

    it('says the config file does not parse, instead of a missing key', async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(join(TMP, '.hwip', 'config.json'), '{"apiKey": "ak_x",');
        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/~\/\.hwip\/config\.json is not valid JSON/);
    });

    // M32: bytes that are not UTF-8 read as U+FFFD, and the rest of the file still parsed: its baseUrl got the key.
    describe('a config file that is not UTF-8 text', () => {
        const writeBytes = (): void => {
            mkdirSync(join(TMP, '.hwip'), { recursive: true });
            writeFileSync(
                join(TMP, '.hwip', 'config.json'),
                Buffer.concat([
                    Buffer.from('{"apiKey":"ak_file","baseUrl":"https://relay.example/'),
                    Buffer.from([0xff, 0xfe]),
                    Buffer.from('","wsUrl":"wss://relay.example/ws"}'),
                ]),
                { mode: 0o600 },
            );
        };

        it('is not used, and says so instead of a missing key', async () => {
            writeBytes();
            const { loadConfig } = await import('./config.js');
            expect(() => loadConfig()).toThrow(/~\/\.hwip\/config\.json is not valid UTF-8 text\. Run `hwip login`/);
        });

        // M31: the file may hold the base URL the key belongs to, so an environment key does not go to the default API without one.
        it('stops an environment key, which cannot go to the default API without the file\'s baseUrl', async () => {
            writeBytes();
            process.env.HWIP_API_KEY = 'ak_env';
            const { loadConfig } = await import('./config.js');
            expect(() => loadConfig()).toThrow(/config\.json is not valid UTF-8 text, so the API base URL it may hold is unknown/);
        });

        it('sends the key from the environment to HWIP_BASE_URL, not to the file\'s baseUrl', async () => {
            writeBytes();
            process.env.HWIP_API_KEY = 'ak_env';
            process.env.HWIP_BASE_URL = 'https://api.example.test';
            vi.spyOn(console, 'error').mockImplementation(() => {});
            const { loadConfig } = await import('./config.js');
            const config = loadConfig();
            expect(config.apiKey).toBe('ak_env');
            expect(config.baseUrl).toBe('https://api.example.test');
            expect(config.wsUrl ?? '').not.toContain('relay.example');
        });
    });

    // M33: with the key in the environment nothing said the file was dropped, and `hwip_ask` then blamed a missing hookId.
    describe('a config file that is dropped while HWIP_API_KEY is set', () => {
        const dir = (): string => {
            mkdirSync(join(TMP, '.hwip'), { recursive: true });
            return join(TMP, '.hwip', 'config.json');
        };
        const loadSaying = async (): Promise<string> => {
            process.env.HWIP_API_KEY = 'ak_env';
            // With the key in the environment and no base URL, a file that cannot be used stops the load instead (M31).
            process.env.HWIP_BASE_URL = 'https://api.example.test';
            const lines: string[] = [];
            vi.spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.join(' ')); });
            const { loadConfig } = await import('./config.js');
            loadConfig();
            loadConfig(); // each line once per process
            return lines.join('\n');
        };

        it('says a file that does not parse is being ignored, without quoting it', async () => {
            // V8 quotes the text around the error for this one ("Unexpected token 'a', …"), key included.
            writeFileSync(dir(), '{"apiKey": ak_secret}', { mode: 0o600 });
            const said = await loadSaying();
            expect(said).toMatch(/\[hwip\] ~\/\.hwip\/config\.json is not valid JSON, so it is being ignored/);
            expect(said.match(/being ignored/g)).toHaveLength(1);
            expect(said).not.toContain('ak_secret');
        });

        // M31 stops an environment key without a base URL for every file it cannot use, this kind included.
        it('stops an environment key without HWIP_BASE_URL for a file that is not an object', async () => {
            writeFileSync(dir(), '["ak_secret"]', { mode: 0o600 });
            process.env.HWIP_API_KEY = 'ak_env';
            const { loadConfig } = await import('./config.js');
            expect(() => loadConfig()).toThrow(/config\.json does not hold a JSON object, so the API base URL it may hold is unknown/);
        });

        it('says a file that is valid JSON but not an object is being ignored', async () => {
            writeFileSync(dir(), '["ak_secret"]', { mode: 0o600 });
            const said = await loadSaying();
            expect(said).toMatch(/config\.json does not hold a JSON object, so it is being ignored/);
            expect(said).not.toContain('ak_secret');
        });

        it.skipIf(process.getuid?.() === 0)('says a file that cannot be read is being ignored', async () => {
            const file = dir();
            writeFileSync(file, '{}', { mode: 0o600 });
            chmodSync(file, 0o000);
            expect(await loadSaying()).toMatch(/config\.json could not be read, so it is being ignored/);
        });

        it('says a file that is not UTF-8 text is being ignored', async () => {
            writeFileSync(dir(), Buffer.from([0x7b, 0xff, 0x7d]), { mode: 0o600 });
            expect(await loadSaying()).toMatch(/config\.json is not valid UTF-8 text, so it is being ignored/);
        });

        it('says nothing for a file that is not there, or a good one', async () => {
            expect(await loadSaying()).not.toMatch(/ignored/);
            vi.resetModules();
            writeFileSync(dir(), JSON.stringify({ hookId: 'h_1' }), { mode: 0o600 });
            expect(await loadSaying()).not.toMatch(/ignored/);
        });
    });

    it('does not quote the file in the error for one that does not parse', async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(join(TMP, '.hwip', 'config.json'), '{"apiKey": ak_live_abcdef123456}', { mode: 0o600 });
        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/config\.json is not valid JSON\. Run/);
        expect(() => loadConfig()).not.toThrow(/ak_live/);
    });

    it('says the config file has no apiKey', async () => {
        writeFileConfig({ hookId: 'h' });
        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/~\/\.hwip\/config\.json has no "apiKey"\. Run `hwip login`/);
    });

    // The base URL has to come from the environment too: the file that may name it cannot be read (see the C112 block below).
    it('uses a key from the environment even when the file does not parse', async () => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(join(TMP, '.hwip', 'config.json'), 'not json');
        process.env.HWIP_API_KEY = 'ak_env';
        process.env.HWIP_BASE_URL = 'https://api.hwip.app/v1';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().apiKey).toBe('ak_env');
    });

    it('reads api key from env', async () => {
        process.env.HWIP_API_KEY = 'ak_from_env';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().apiKey).toBe('ak_from_env');
    });

    it('falls back to ~/.hwip/config.json when env is missing', async () => {
        writeFileConfig({ apiKey: 'ak_from_file', hookId: 'hook_file' });
        const { loadConfig } = await import('./config.js');
        const cfg = loadConfig();
        expect(cfg.apiKey).toBe('ak_from_file');
        expect(cfg.hookId).toBe('hook_file');
    });

    it('env takes precedence over file', async () => {
        writeFileConfig({ apiKey: 'ak_from_file' });
        process.env.HWIP_API_KEY = 'ak_from_env';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().apiKey).toBe('ak_from_env');
    });

    it('treats unresolved ${VAR} placeholder as unset (env layer)', async () => {
        // Catches a real bug: some IDEs spawn MCP with env: { HWIP_API_KEY: "${HWIP_API_KEY}" }
        // and if the outer shell doesn't have the var, the literal "${...}"
        // string would otherwise be treated as the key.
        process.env.HWIP_API_KEY = '${HWIP_API_KEY}';
        writeFileConfig({ apiKey: 'ak_from_file' });
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().apiKey).toBe('ak_from_file');
    });

    it('strips trailing slash from baseUrl', async () => {
        process.env.HWIP_API_KEY = 'ak';
        process.env.HWIP_BASE_URL = 'https://api.example.com/v1/';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().baseUrl).toBe('https://api.example.com/v1');
    });

    it('defaults baseUrl to prod when nothing is provided', async () => {
        process.env.HWIP_API_KEY = 'ak';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().baseUrl).toBe('https://api.hwip.app/v1');
    });

    it('generates a sess_ prefix sessionId when nothing is provided', async () => {
        process.env.HWIP_API_KEY = 'ak';
        const { loadConfig } = await import('./config.js');
        const cfg = loadConfig();
        expect(cfg.sessionId).toMatch(/^sess_/);
    });

    it('respects HWIP_SESSION_ID env override', async () => {
        process.env.HWIP_API_KEY = 'ak';
        process.env.HWIP_SESSION_ID = 'my-custom-session-id';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().sessionId).toBe('my-custom-session-id');
    });

    it('derives projectName from CLAUDE_PROJECT_DIR basename', async () => {
        process.env.HWIP_API_KEY = 'ak';
        process.env.CLAUDE_PROJECT_DIR = '/Users/me/code/my-project';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().projectName).toBe('my-project');
    });

    it('uses CURSOR_PROJECT_DIR when CLAUDE_PROJECT_DIR is absent', async () => {
        process.env.HWIP_API_KEY = 'ak';
        process.env.CURSOR_PROJECT_DIR = '/work/cursor-proj';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().projectName).toBe('cursor-proj');
    });

    it('CLAUDE_PROJECT_DIR takes precedence over CURSOR_PROJECT_DIR', async () => {
        process.env.HWIP_API_KEY = 'ak';
        process.env.CLAUDE_PROJECT_DIR = '/a/claude-proj';
        process.env.CURSOR_PROJECT_DIR = '/b/cursor-proj';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().projectName).toBe('claude-proj');
    });

    it('falls back to cwd basename when no project env is set', async () => {
        process.env.HWIP_API_KEY = 'ak';
        const { loadConfig } = await import('./config.js');
        const expected = process.cwd().split('/').filter(Boolean).pop();
        expect(loadConfig().projectName).toBe(expected);
    });
});

describe('formatPushTitle', () => {
    it('prefixes the project name with a separator', async () => {
        const { formatPushTitle } = await import('./config.js');
        expect(formatPushTitle('hwip', 'Build finished')).toBe('hwip · Build finished');
    });

    it('is idempotent — does not double-prefix the same project', async () => {
        const { formatPushTitle } = await import('./config.js');
        const once = formatPushTitle('hwip', 'Build finished');
        expect(formatPushTitle('hwip', once)).toBe('hwip · Build finished');
    });

    it('still prefixes when a different project segment is already present', async () => {
        const { formatPushTitle } = await import('./config.js');
        expect(formatPushTitle('web', 'api · Deploy done')).toBe('web · api · Deploy done');
    });
});

describe('writeSessionCache (via loadConfig)', () => {
    const sessionFiles = (): string[] => {
        const dir = join(TMP, '.cache', 'hwip');
        if (!existsSync(dir)) return [];
        return require('node:fs').readdirSync(dir).filter((f: string) => f.startsWith('session-'));
    };

    it('writes the session id under $HOME/.cache/hwip/ by default', async () => {
        process.env.HWIP_API_KEY = 'ak';
        process.env.CLAUDE_PROJECT_DIR = '/some/test/project';
        const { loadConfig } = await import('./config.js');
        loadConfig();
        const files = sessionFiles();
        expect(files.length).toBe(1);
    });

    it('writes the session cache when only CURSOR_PROJECT_DIR is set', async () => {
        process.env.HWIP_API_KEY = 'ak';
        process.env.CURSOR_PROJECT_DIR = '/work/cursor-only';
        const { loadConfig } = await import('./config.js');
        loadConfig();
        expect(sessionFiles().length).toBe(1);
    });

    it('honors $XDG_CACHE_HOME when set', async () => {
        const xdg = join(TMP, 'custom-cache');
        process.env.HWIP_API_KEY = 'ak';
        process.env.XDG_CACHE_HOME = xdg;
        process.env.CLAUDE_PROJECT_DIR = '/another/project';
        const { loadConfig } = await import('./config.js');
        loadConfig();
        // Default ~/.cache should not have been used
        expect(existsSync(join(TMP, '.cache', 'hwip'))).toBe(false);
        expect(existsSync(join(xdg, 'hwip'))).toBe(true);
    });

    it('opt-out via HWIP_DISABLE_SESSION_CACHE=1', async () => {
        process.env.HWIP_API_KEY = 'ak';
        process.env.HWIP_DISABLE_SESSION_CACHE = '1';
        process.env.CLAUDE_PROJECT_DIR = '/opted/out';
        const { loadConfig } = await import('./config.js');
        loadConfig();
        expect(sessionFiles().length).toBe(0);
    });

    it('opt-out also accepts true / yes / on (case-insensitive, trimmed)', async () => {
        for (const val of ['true', 'TRUE', 'yes', 'On', '  true  ']) {
            process.env.HWIP_API_KEY = 'ak';
            process.env.HWIP_DISABLE_SESSION_CACHE = val;
            process.env.CLAUDE_PROJECT_DIR = '/opted/out';
            // Re-import within the loop for env-capture freshness
            vi.resetModules();
            const { loadConfig } = await import('./config.js');
            loadConfig();
            expect(sessionFiles().length).toBe(0);
            delete process.env.HWIP_DISABLE_SESSION_CACHE;
        }
    });
});

describe('detectClaudeSessionId (via loadConfig)', () => {
    // M28: Claude Code flattens `.`, `_`, spaces and Hangul too, so a project
    // like `llm_wiki` never found its session id.
    it('finds the session of a project dir with an underscore, space and Hangul', async () => {
        const uuid = '12345678-1234-1234-1234-1234567890ab';
        process.env.HWIP_API_KEY = 'ak';
        process.env.CLAUDE_PROJECT_DIR = '/Users/x/내 프로젝트/work/llm_wiki';
        const sessionsDir = join(TMP, '.claude', 'projects', '-Users-x--------work-llm-wiki');
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, `${uuid}.jsonl`), '{}');

        const { loadConfig } = await import('./config.js');
        expect(loadConfig().sessionId).toBe(uuid);
    });

    it('detects the session UUID from a ~/.claude/projects/<hash>/<uuid>.jsonl file', async () => {
        const projectDir = '/some/test/project';
        const uuid = '12345678-1234-1234-1234-1234567890ab';
        process.env.HWIP_API_KEY = 'ak';
        process.env.CLAUDE_PROJECT_DIR = projectDir;

        // Only slashes to flatten here, so '/' → '-' is the whole rule (leading dash included).
        const projectHash = projectDir.replace(/\//g, '-');
        const sessionsDir = join(TMP, '.claude', 'projects', projectHash);
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, `${uuid}.jsonl`), '{}');

        const { loadConfig } = await import('./config.js');
        expect(loadConfig().sessionId).toBe(uuid);
    });

    // Two agents in one project: the transcript scan takes the newest file, so
    // it hands back the sibling's id and the server threads this session's
    // pushes into the neighbour's chat. Claude Code names the running session,
    // so prefer that.
    it('prefers CLAUDE_CODE_SESSION_ID over a newer sibling transcript', async () => {
        const projectDir = '/some/test/project';
        const mine = '11111111-1111-1111-1111-111111111111';
        const sibling = '22222222-2222-2222-2222-222222222222';
        process.env.HWIP_API_KEY = 'ak';
        process.env.CLAUDE_PROJECT_DIR = projectDir;
        process.env.CLAUDE_CODE_SESSION_ID = mine;

        // Only slashes to flatten here, as in the test above.
        const sessionsDir = join(TMP, '.claude', 'projects', projectDir.replace(/\//g, '-'));
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, `${mine}.jsonl`), '{}');
        // Written second — the sibling is what an mtime scan would return.
        writeFileSync(join(sessionsDir, `${sibling}.jsonl`), '{}');

        const { loadConfig } = await import('./config.js');
        expect(loadConfig().sessionId).toBe(mine);
    });

    it('lets HWIP_SESSION_ID override the Claude-provided id', async () => {
        process.env.HWIP_API_KEY = 'ak';
        process.env.CLAUDE_CODE_SESSION_ID = '11111111-1111-1111-1111-111111111111';
        process.env.HWIP_SESSION_ID = 'sess_explicit';

        const { loadConfig } = await import('./config.js');
        expect(loadConfig().sessionId).toBe('sess_explicit');
    });
});

// The variable used to outrank ~/.hwip/config.json for the WebSocket endpoint.
// It is no longer read, and saying so is the difference between a removal and
// the silent override it replaced.
describe('legacyWsEnvNotice', () => {
    it('tells a machine with no config where the value belongs', async () => {
        const { legacyWsEnvNotice } = await import('./config.js');
        const notice = legacyWsEnvNotice({}, { HWIP_WS_URL: 'wss://old' });
        expect(notice).toContain('HWIP_WS_URL');
        expect(notice).toContain('wsUrl');
        expect(notice).not.toContain('does nothing');
    });

    it('tells a migrated machine the export is now dead weight', async () => {
        const { legacyWsEnvNotice } = await import('./config.js');
        expect(legacyWsEnvNotice({ wsUrl: 'wss://cfg' }, { HWIP_WS_URL: 'wss://old' }))
            .toContain('does nothing');
    });

    // An unexpanded "${HWIP_WS_URL}" from an agent's env block is a
    // placeholder. Nagging someone to migrate a value they never had is worse
    // than saying nothing.
    it('says nothing when it is absent, empty, or an unexpanded placeholder', async () => {
        const { legacyWsEnvNotice } = await import('./config.js');
        expect(legacyWsEnvNotice({}, {})).toBeNull();
        expect(legacyWsEnvNotice({}, { HWIP_WS_URL: '' })).toBeNull();
        expect(legacyWsEnvNotice({}, { HWIP_WS_URL: '${HWIP_WS_URL}' })).toBeNull();
    });
});

// The inversion is the whole change: the export used to win. A revert of that
// one line has to fail here, which asserting the notice text alone would not do.
describe('loadConfig wsUrl precedence', () => {
    it('tells a machine whose export is still the answer to move it, not drop it', async () => {
        writeFileConfig({ apiKey: 'ak_x' });
        process.env.HWIP_API_KEY = 'ak_env'; // M29: with the file's key the export is not followed
        process.env.HWIP_WS_URL = 'wss://from-env';
        const { loadConfig, legacyWsEnvNotice } = await import('./config.js');
        expect(loadConfig().wsUrl).toBe('wss://from-env');
        expect(legacyWsEnvNotice()).toMatch(/deprecated/);
    });

    it('defaults to the prod socket with the prod API, like the cli listener', async () => {
        writeFileConfig({ apiKey: 'ak_x' });
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().wsUrl).toBe('wss://ws.hwip.app');
    });

    it('guesses no socket for another API base', async () => {
        writeFileConfig({ apiKey: 'ak_x', baseUrl: 'https://api.hwip.app/d1' });
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().wsUrl).toBeUndefined();
    });

    it('lets ~/.hwip/config.json beat HWIP_WS_URL', async () => {
        writeFileConfig({ apiKey: 'ak_x', wsUrl: 'wss://from-file' });
        process.env.HWIP_WS_URL = 'wss://from-env';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().wsUrl).toBe('wss://from-file');
    });

    it('still answers from the environment when the file has no wsUrl', async () => {
        writeFileConfig({ apiKey: 'ak_x' });
        process.env.HWIP_API_KEY = 'ak_env';
        process.env.HWIP_WS_URL = 'wss://from-env';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().wsUrl).toBe('wss://from-env');
    });
});

// M29: the key in the config file was sent to whatever address the environment named — an `export` in a shell
// profile, a project's env block. It belongs to the addresses the file says; only a key given in the environment
// too, or the same origin, follows the environment's.
describe('loadConfig: a key from the config file and an address from the environment', () => {
    const say = (): string[] => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.join(' ')); });
        return lines;
    };

    it('does not send the file key to an HWIP_BASE_URL on another origin', async () => {
        writeFileConfig({ apiKey: 'ak_file' });
        process.env.HWIP_BASE_URL = 'https://evil.example/v1';
        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/HWIP_BASE_URL points at https:\/\/evil\.example, but the API key in ~\/\.hwip\/config\.json belongs to https:\/\/api\.hwip\.app/);
        expect(() => loadConfig()).toThrow(/set HWIP_API_KEY as well, or unset HWIP_BASE_URL/);
    });

    it('does not follow it from the file\'s own baseUrl either', async () => {
        writeFileConfig({ apiKey: 'ak_file', baseUrl: 'https://self-hosted.example/v1' });
        process.env.HWIP_BASE_URL = 'https://api.hwip.app/v1';
        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/belongs to https:\/\/self-hosted\.example/);
    });

    it('is not fooled by the origin\'s lookalikes: another port, scheme, subdomain or userinfo', async () => {
        writeFileConfig({ apiKey: 'ak_file', baseUrl: 'https://api.example.com/v1' });
        const { loadConfig } = await import('./config.js');
        for (const env of [
            'https://api.example.com:8443/v1', 'http://api.example.com/v1', 'https://api.example.com.evil.example/v1',
            'https://api.example.com@evil.example/v1', 'https://evil.example/https://api.example.com/v1',
        ]) {
            process.env.HWIP_BASE_URL = env;
            expect(() => loadConfig(), env).toThrow(/is not sent there/);
        }
    });

    it('names the origin only: no userinfo, path or query of the environment\'s URL, and no key', async () => {
        writeFileConfig({ apiKey: 'ak_file_secret' });
        process.env.HWIP_BASE_URL = 'https://user:pw@evil.example/v1?token=t0k';
        const { loadConfig } = await import('./config.js');
        let message = '';
        try { loadConfig(); } catch (err) { message = (err as Error).message; }
        expect(message).toContain('https://evil.example');
        for (const secret of ['user', 'pw', 't0k', 'ak_file_secret', '/v1']) expect(message).not.toContain(secret);
    });

    it('stops for an address that is not a URL, saying so', async () => {
        writeFileConfig({ apiKey: 'ak_file' });
        process.env.HWIP_BASE_URL = 'not a url';
        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/HWIP_BASE_URL points at something that is not a URL/);
    });

    it('follows the environment on the same origin, whatever the path', async () => {
        writeFileConfig({ apiKey: 'ak_file', baseUrl: 'https://api.example.com/v1' });
        process.env.HWIP_BASE_URL = 'https://api.example.com/v2/';
        const { loadConfig } = await import('./config.js');
        const config = loadConfig();
        expect(config.apiKey).toBe('ak_file');
        expect(config.baseUrl).toBe('https://api.example.com/v2');
    });

    it('treats a file without a baseUrl, or an empty one, as the default API', async () => {
        const { loadConfig } = await import('./config.js');
        for (const file of [{ apiKey: 'ak_file' }, { apiKey: 'ak_file', baseUrl: '' }]) {
            writeFileConfig(file);
            process.env.HWIP_BASE_URL = 'https://api.hwip.app/v1';
            expect(loadConfig().apiKey).toBe('ak_file');
            process.env.HWIP_BASE_URL = 'https://staging.example/v1';
            expect(() => loadConfig()).toThrow(/belongs to https:\/\/api\.hwip\.app/);
        }
    });

    it('follows the environment to any address when the key is in the environment too', async () => {
        writeFileConfig({ apiKey: 'ak_file' });
        process.env.HWIP_API_KEY = 'ak_env';
        process.env.HWIP_BASE_URL = 'https://staging.example/v1';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig()).toMatchObject({ apiKey: 'ak_env', baseUrl: 'https://staging.example/v1' });
    });

    it('sends nothing to the environment\'s HWIP_WS_URL with the file key, and says so once', async () => {
        writeFileConfig({ apiKey: 'ak_file' });
        process.env.HWIP_WS_URL = 'wss://evil.example/ws';
        const lines = say();
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().wsUrl).toBe('wss://ws.hwip.app'); // the default, as if the export were not there
        loadConfig();
        expect(lines.filter((l) => l.includes('HWIP_WS_URL is not used'))).toHaveLength(1);
        expect(lines.join('\n')).not.toContain('evil.example');
    });

    it('still takes an HWIP_WS_URL on the default socket\'s origin with the file key', async () => {
        writeFileConfig({ apiKey: 'ak_file' });
        process.env.HWIP_WS_URL = 'wss://ws.hwip.app/other';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().wsUrl).toBe('wss://ws.hwip.app/other');
    });

    it('does not take it for another API base either: no socket address is known for that key', async () => {
        writeFileConfig({ apiKey: 'ak_file', baseUrl: 'https://api.example.com/v1' });
        process.env.HWIP_WS_URL = 'wss://ws.hwip.app';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().wsUrl).toBeUndefined();
    });

    it('keeps the file\'s own wsUrl, which beats the environment as before', async () => {
        writeFileConfig({ apiKey: 'ak_file', wsUrl: 'wss://from-file.example' });
        process.env.HWIP_WS_URL = 'wss://evil.example/ws';
        const lines = say();
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().wsUrl).toBe('wss://from-file.example');
        // The export is not in play here, so there is nothing to say about refusing it.
        expect(lines.join('\n')).not.toContain('is not used');
    });

    it('does not take two addresses without an origin for the same one', async () => {
        writeFileConfig({ apiKey: 'ak_file', baseUrl: 'data:text/plain,a' });
        process.env.HWIP_BASE_URL = 'data:text/plain,b';
        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/is not sent there/);
    });
});

// Same vectors as cli/src/remote-agents.test.ts — keep the two in step.
describe('claudeProjectDirName', () => {
    // Pairs read off a real ~/.claude/projects against each session's cwd.
    it.each([
        ['/Users/me/workspace/acme/team/llm_wiki', '-Users-me-workspace-acme-team-llm-wiki'],
        ['/Users/me/.claude-mem/observer-sessions', '-Users-me--claude-mem-observer-sessions'],
        [
            '/private/var/folders/xz/n9kql91d5bg7mr71dqkz4c_00000gn/T/ux-probe-Pr69TH/vault',
            '-private-var-folders-xz-n9kql91d5bg7mr71dqkz4c-00000gn-T-ux-probe-Pr69TH-vault',
        ],
        ['/Users/x/내 프로젝트/a@b_c', '-Users-x--------a-b-c'],
    ])('%s', async (cwd, expected) => {
        const { claudeProjectDirName } = await import('./config.js');
        expect(claudeProjectDirName(cwd)).toBe(expected);
    });

    // Vector computed outside JS (Python port of the Java-style hash).
    it('cuts a name past 200 characters and suffixes the cwd hash', async () => {
        const { claudeProjectDirName } = await import('./config.js');
        const cwd = `/Users/dev/${'deep_dir/'.repeat(25)}repo`;
        expect(claudeProjectDirName(cwd)).toBe(`-Users-dev${'-deep-dir'.repeat(21)}--1f4pbr`);
    });

    it('keeps a name of exactly 200 characters and cuts one of 201', async () => {
        const { claudeProjectDirName } = await import('./config.js');
        expect(claudeProjectDirName(`/${'a'.repeat(199)}`)).toBe(`-${'a'.repeat(199)}`);
        // Vector computed outside JS, as above.
        expect(claudeProjectDirName(`/${'a'.repeat(200)}`)).toBe(`-${'a'.repeat(199)}-b6ymvl`);
    });
});

// M30 (the mcp-server half of cli C103): the file holds the API key and says where
// to send it, so one that anyone can write is a way to redirect the key.
describe('config.json ownership and mode', () => {
    const configPath = () => join(TMP, '.hwip', 'config.json');
    const stderr = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

    it('ignores a file anyone can write, so its baseUrl cannot redirect the key', async () => {
        const warn = stderr();
        writeFileConfig({ apiKey: 'ak_file', baseUrl: 'https://evil.example', hookId: 'h' });
        chmodSync(configPath(), 0o666);
        process.env.HWIP_API_KEY = 'ak_env';
        const { loadConfig } = await import('./config.js');

        const cfg = loadConfig();

        expect(cfg.baseUrl).toBe('https://api.hwip.app/v1');
        expect(cfg.hookId).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/can be written by anyone \(mode 666\).*being ignored/));
    });

    it('says why there is no key when the only source is a file it ignored', async () => {
        stderr();
        writeFileConfig({ apiKey: 'ak_file' });
        chmodSync(configPath(), 0o666);
        const { loadConfig } = await import('./config.js');

        expect(() => loadConfig()).toThrow(/No API key: .*can be written by anyone.*ignored/);
    });

    it('uses a file the group can read, with a warning that names the mode', async () => {
        const warn = stderr();
        writeFileConfig({ apiKey: 'ak_file' });
        chmodSync(configPath(), 0o640);
        const { loadConfig } = await import('./config.js');

        expect(loadConfig().apiKey).toBe('ak_file');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('mode 640'));
    });

    it('stays quiet for 0600 and warns once however many times it is read', async () => {
        const warn = stderr();
        writeFileConfig({ apiKey: 'ak_file' });
        const { loadConfig } = await import('./config.js');
        loadConfig();
        expect(warn).not.toHaveBeenCalled();

        chmodSync(configPath(), 0o644);
        loadConfig();
        loadConfig();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('judges a symlinked file (dotfiles) by what it points at', async () => {
        stderr();
        const target = join(TMP, 'dotfiles-config.json');
        writeFileSync(target, JSON.stringify({ apiKey: 'ak_linked' }));
        chmodSync(target, 0o666);
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        symlinkSync(target, configPath());
        const { loadConfig } = await import('./config.js');

        expect(() => loadConfig()).toThrow(/No API key/);
    });

    it('is ignored when another user owns it, whatever the mode', async () => {
        const { configModeProblem } = await import('./config.js');

        expect(configModeProblem({ uid: 0, mode: 0o100600 }, 501, '/h/.hwip/config.json')).toEqual({
            refuse: true,
            why: '/h/.hwip/config.json belongs to another user (uid 0), so it is being ignored (HWIP_API_KEY still works)',
        });
        // Group-write alone (no read bit) is still access for others.
        expect(configModeProblem({ uid: 501, mode: 0o100620 }, 501)).toMatchObject({ refuse: false, why: expect.stringContaining('mode 620') });
        expect(configModeProblem({ uid: 501, mode: 0o100600 }, 501)).toBeNull();
        // sudo keeps HOME: root reads what a user owns.
        expect(configModeProblem({ uid: 501, mode: 0o100600 }, 0)).toBeNull();
    });
});

describe('loadConfig URL checks', () => {
    const stderr = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

    it('drops a wsUrl that is not a socket URL, and says so without quoting the key', async () => {
        const warn = stderr();
        process.env.HWIP_API_KEY = 'ak';
        writeFileConfig({ wsUrl: 'https://user:hunter2@ws.example.com/p?apiKey=ak_SECRET' });
        const { loadConfig } = await import('./config.js');

        // The default base URL keeps its default socket; the bad value is not used.
        expect(loadConfig().wsUrl).toBe('wss://ws.hwip.app');
        const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(said).toMatch(/must start with ws:\/\/ or wss:\/\//);
        expect(said).not.toMatch(/hunter2|ak_SECRET/);
    });

    it('goes without a socket (polling) when a self-hosted wsUrl is bad', async () => {
        stderr();
        process.env.HWIP_API_KEY = 'ak';
        process.env.HWIP_BASE_URL = 'https://api.example.com';
        writeFileConfig({ wsUrl: 'ws.example.com' });
        const { loadConfig } = await import('./config.js');

        expect(loadConfig().wsUrl).toBeUndefined();
    });

    it('drops a non-string wsUrl from the file', async () => {
        stderr();
        process.env.HWIP_API_KEY = 'ak';
        process.env.HWIP_BASE_URL = 'https://api.example.com';
        writeFileConfig({ wsUrl: 443 });
        const { loadConfig } = await import('./config.js');

        expect(loadConfig().wsUrl).toBeUndefined();
    });

    it('does not hand a bad wsUrl in the file to an exported HWIP_WS_URL: the file wins whole', async () => {
        stderr();
        process.env.HWIP_API_KEY = 'ak';
        process.env.HWIP_BASE_URL = 'https://api.example.com';
        process.env.HWIP_WS_URL = 'wss://ws-dev.example.com';
        writeFileConfig({ wsUrl: 'ws.example.com' });
        const { loadConfig } = await import('./config.js');

        expect(loadConfig().wsUrl).toBeUndefined();
    });

    it('checks the legacy HWIP_WS_URL the same way', async () => {
        stderr();
        process.env.HWIP_API_KEY = 'ak';
        process.env.HWIP_BASE_URL = 'https://api.example.com';
        process.env.HWIP_WS_URL = 'ftp://ws.example.com';
        const { loadConfig } = await import('./config.js');

        expect(loadConfig().wsUrl).toBeUndefined();
    });

    it('warns once for plain ws:// and http:// off this machine, and keeps using them', async () => {
        const warn = stderr();
        process.env.HWIP_API_KEY = 'ak';
        process.env.HWIP_BASE_URL = 'http://api.example.com';
        process.env.HWIP_WS_URL = 'ws://ws.example.com';
        const { loadConfig } = await import('./config.js');

        const cfg = loadConfig();
        loadConfig();

        expect(cfg.baseUrl).toBe('http://api.example.com');
        expect(cfg.wsUrl).toBe('ws://ws.example.com');
        const said = warn.mock.calls.map((c) => String(c[0]));
        expect(said.filter((m) => m.includes('plain http://'))).toHaveLength(1);
        expect(said.filter((m) => m.includes('plain ws://'))).toHaveLength(1);
    });

    it('does not warn for loopback or https', async () => {
        const warn = stderr();
        process.env.HWIP_API_KEY = 'ak';
        process.env.HWIP_BASE_URL = 'http://localhost:3000';
        process.env.HWIP_WS_URL = 'ws://127.0.0.1:3001';
        const { loadConfig } = await import('./config.js');

        loadConfig();

        expect(warn).not.toHaveBeenCalled();
    });
});

// C112 / M31: the file may hold the base URL the key belongs to (staging, self-hosted). A key from the
// environment must not be sent to the default API because the file that says otherwise cannot be read.
// Same rule as the cli's `resolveBaseUrl`.
describe('loadConfig base URL when config.json cannot be read', () => {
    const configPath = () => join(TMP, '.hwip', 'config.json');
    const writeRaw = (text: string, mode = 0o600): void => {
        mkdirSync(join(TMP, '.hwip'), { recursive: true });
        writeFileSync(configPath(), text, { mode });
    };
    const BROKEN = '{ "apiKey": "ak_file", "baseUrl": "https://stage.example/v1", }';
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        process.env.HWIP_API_KEY = 'ak_env';
    });

    it.each([
        ['does not parse', BROKEN, /config\.json is not valid JSON/],
        ['is not an object', '["https://stage.example/v1"]', /config\.json does not hold a JSON object/],
    ])('stops, naming the file and the way out, when it %s', async (_why, text, why) => {
        writeRaw(text);
        const { loadConfig } = await import('./config.js');

        expect(() => loadConfig()).toThrow(why);
        expect(() => loadConfig()).toThrow(/API base URL it may hold is unknown.*HWIP_BASE_URL/);
    });

    it('stops for a file it cannot read', async () => {
        if (process.getuid?.() === 0) return; // root reads mode 000
        writeRaw('{}', 0o000);
        const { loadConfig } = await import('./config.js');

        expect(() => loadConfig()).toThrow(/could not be read.*API base URL it may hold is unknown/);
    });

    it('goes ahead when HWIP_BASE_URL says where the key goes', async () => {
        writeRaw(BROKEN);
        process.env.HWIP_BASE_URL = 'https://stage.example/v1/';
        const { loadConfig } = await import('./config.js');

        expect(loadConfig().baseUrl).toBe('https://stage.example/v1');
    });

    // `resolvedEnv` treats an unexpanded placeholder as unset; reading process.env raw would let it past the guard.
    it('stops when HWIP_BASE_URL is an unexpanded placeholder: that is no base either', async () => {
        writeRaw(BROKEN);
        process.env.HWIP_BASE_URL = '${HWIP_BASE_URL}';
        const { loadConfig } = await import('./config.js');

        expect(() => loadConfig()).toThrow(/API base URL it may hold is unknown/);
    });

    // As the cli reads it: an empty file has no base URL to lose.
    it('treats an empty file as no config, not as an unreadable one', async () => {
        writeRaw(' \n');
        const { loadConfig } = await import('./config.js');

        expect(loadConfig().baseUrl).toBe('https://api.hwip.app/v1');
    });

    it('takes an empty baseUrl as unset, as the cli does', async () => {
        writeRaw('{ "baseUrl": "" }');
        const { loadConfig } = await import('./config.js');

        expect(loadConfig().baseUrl).toBe('https://api.hwip.app/v1');
    });

    it('has no side effect before it stops: no session cache is written', async () => {
        writeRaw(BROKEN);
        const { loadConfig } = await import('./config.js');

        expect(() => loadConfig()).toThrow();

        expect(existsSync(join(TMP, '.cache', 'hwip'))).toBe(false);
    });

    // A file that is ignored on purpose (anyone can write it) is not trusted for a base URL either: the default stands.
    it('uses the default API for a file ignored for its mode', async () => {
        writeRaw(BROKEN, 0o666);
        chmodSync(configPath(), 0o666);
        const { loadConfig } = await import('./config.js');

        expect(loadConfig().baseUrl).toBe('https://api.hwip.app/v1');
    });

    it('is not asked of a file that is not there or that names no baseUrl', async () => {
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().baseUrl).toBe('https://api.hwip.app/v1');
        writeRaw('{ "hookId": "h" }');
        vi.resetModules();
        expect((await import('./config.js')).loadConfig().baseUrl).toBe('https://api.hwip.app/v1');
    });

    it('stops for a baseUrl that is not text: it is no URL', async () => {
        writeRaw('{ "baseUrl": true }');
        const { loadConfig } = await import('./config.js');

        expect(() => loadConfig()).toThrow(/"baseUrl" that is not text.*HWIP_BASE_URL/);
    });

    it.each(['true', 'null', '123'])('stops for "baseUrl": %s, like the cli, unless HWIP_BASE_URL says where', async (value) => {
        writeRaw(`{ "baseUrl": ${value} }`);
        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/"baseUrl" that is not text/);

        process.env.HWIP_BASE_URL = 'https://stage.example/v1';
        vi.resetModules();
        expect((await import('./config.js')).loadConfig().baseUrl).toBe('https://stage.example/v1');
    });
});

// The key goes out as a header on every call. One `fetch` cannot send as a header fails each call — with an
// error that quotes it whole when what it has is a NUL, CR or LF, and that error is on its way to the model:
// stopped here, where the message is ours.
describe('an API key that cannot go in a header', () => {
    const load = async () => (await import('./config.js')).loadConfig();
    const server = createServer((_, res) => res.end());
    beforeAll(async () => { await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening)); });
    afterAll(() => { server.close(); });
    /**
     * What `fetch` itself does with the value: a real send, not a rule written down here. `Headers` alone
     * takes more than is sent — a bell or a DEL passes it and is refused at the send (UND_ERR_INVALID_ARG).
     */
    const fetchTakes = async (value: string): Promise<boolean> => {
        const { port } = server.address() as AddressInfo; // listening on a port: never the pipe's string, never null
        try {
            await fetch(`http://127.0.0.1:${port}/`, { headers: { 'X-API-Key': value } });
            return true;
        } catch {
            return false;
        }
    };

    it.each([
        'ak_plain', 'ak_trailing_newline\n', ' ak_padded ', '\tak_tabbed\r\n', 'ak inner space', 'ak_inner\ttab', 'ak_latin1_\u00e9', 'ak_c1_\u0080', 'ak_last_\u00ff',
        'ak_inner\nnewline', 'ak_inner\rreturn', 'ak_nul\u0000byte', 'ak_wide_\u4e2d', 'ak_emoji_\u{1f600}',
        'ak_bell_\u0007', 'ak_del_\u007f', 'ak_vtab_\u000bx', '\u000cak_leading_feed', 'ak_escape_\u001bx',
    ])('takes %j exactly when fetch would send it', async (value) => {
        writeFileConfig({ apiKey: value });
        if (await fetchTakes(value)) await expect(load()).resolves.toMatchObject({ apiKey: value });
        else await expect(load()).rejects.toThrow(/cannot be sent/);
    });

    // The file is JSON anyone may have edited: a key that is a number is a mistake to name, as a base URL that is one is.
    it.each([12345, 0, true, false, ['ak_x'], { key: 'ak_x' }])('says a key in the file that is %j is not text', async (apiKey) => {
        writeFileConfig({ apiKey });
        await expect(load()).rejects.toThrow(/~\/\.hwip\/config\.json has an "apiKey" that is not text/);
    });

    it('says where the key came from, and none of what it is', async () => {
        writeFileConfig({ apiKey: 'zq9_first\nSECRETTAIL' });
        await expect(load()).rejects.toThrow(/~\/\.hwip\/config\.json/);
        await expect(load()).rejects.not.toThrow(/zq9|SECRETTAIL/);

        process.env.HWIP_API_KEY = 'zq9_first\rSECRETTAIL';
        await expect(load()).rejects.toThrow(/HWIP_API_KEY/);
        await expect(load()).rejects.not.toThrow(/zq9|SECRETTAIL|config\.json/);
    });

    // M41: white space alone passes fitsInHeader and then fails every call as UNAUTHORIZED.
    it.each(['   ', '\t \r\n '])('refuses a blank key %j at startup instead of every call', async (apiKey) => {
        writeFileConfig({ apiKey });
        await expect(load()).rejects.toThrow(/blank/);

        process.env.HWIP_API_KEY = apiKey;
        await expect(load()).rejects.toThrow(/HWIP_API_KEY.*blank/);
    });
});
