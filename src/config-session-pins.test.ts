import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTmuxSessionName, type CommandRunner } from './config.js';

// Pins for how config finds the session id (the newest transcript, a 0 in the uuid, a fresh id) and
// how the tmux pane search walks up the process tree (t96 note #9).

const KEYS = ['HOME', 'HWIP_API_KEY', 'HWIP_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HWIP_DISABLE_SESSION_CACHE', 'CLAUDE_PROJECT_DIR', 'XDG_CACHE_HOME'] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

let TMP: string;
const PROJECT = '/some/test/project';

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'mcp-session-pins-'));
    for (const k of KEYS) delete process.env[k];
    process.env.HOME = TMP;
    process.env.HWIP_API_KEY = 'ak';
    process.env.CLAUDE_PROJECT_DIR = PROJECT;
    vi.resetModules();
});

afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

const sessionsDir = () => {
    const dir = join(TMP, '.claude', 'projects', PROJECT.replace(/\//g, '-'));
    mkdirSync(dir, { recursive: true });
    return dir;
};
const at = (path: string, seconds: number) => utimesSync(path, seconds, seconds);
const sessionId = async () => {
    const { loadConfig } = await import('./config.js');
    return loadConfig().sessionId;
};

describe('the session id from ~/.claude/projects', () => {
    it('takes a uuid with a 0 in every group', async () => {
        const uuid = '01234567-0123-0123-0123-012345678901';
        writeFileSync(join(sessionsDir(), `${uuid}.jsonl`), '{}');
        expect(await sessionId()).toBe(uuid);
    });

    it('takes an all-zero uuid', async () => {
        const uuid = '00000000-0000-0000-0000-000000000000';
        writeFileSync(join(sessionsDir(), `${uuid}.jsonl`), '{}');
        expect(await sessionId()).toBe(uuid);
    });

    it('passes over files that are not <uuid>.jsonl, whatever order the directory lists them in', async () => {
        const dir = sessionsDir();
        const uuid = '12345678-1234-1234-1234-1234567890ab';
        writeFileSync(join(dir, `${uuid}.jsonl`), '{}');
        for (const other of ['notes.txt', 'agent-1.jsonl', `${uuid}.json`, `x${uuid}.jsonl`, `${uuid.toUpperCase()}.jsonl`]) {
            writeFileSync(join(dir, other), '{}');
            at(join(dir, other), 2_000_000_000);
        }
        expect(await sessionId()).toBe(uuid);
    });

    it('ignores a directory named like a transcript even when it is newer', async () => {
        const dir = sessionsDir();
        const file = '11111111-1111-1111-1111-111111111111';
        const folder = '22222222-2222-2222-2222-222222222222';
        writeFileSync(join(dir, `${file}.jsonl`), '{}');
        mkdirSync(join(dir, `${folder}.jsonl`));
        at(join(dir, `${file}.jsonl`), 1_000_000_000);
        at(join(dir, `${folder}.jsonl`), 2_000_000_000);
        expect(await sessionId()).toBe(file);
    });

    it('takes the newest transcript, in either directory order', async () => {
        const dir = sessionsDir();
        const old = '11111111-1111-1111-1111-111111111111';
        const fresh = '22222222-2222-2222-2222-222222222222';
        writeFileSync(join(dir, `${old}.jsonl`), '{}');
        writeFileSync(join(dir, `${fresh}.jsonl`), '{}');
        at(join(dir, `${old}.jsonl`), 1_000_000_000);
        at(join(dir, `${fresh}.jsonl`), 1_000_000_500);
        expect(await sessionId()).toBe(fresh);
        at(join(dir, `${old}.jsonl`), 1_000_001_000);
        vi.resetModules();
        expect(await sessionId()).toBe(old);
    });

    it('keeps the first one listed when two transcripts have the same mtime', async () => {
        const dir = sessionsDir();
        const a = '11111111-1111-1111-1111-111111111111';
        const b = '22222222-2222-2222-2222-222222222222';
        writeFileSync(join(dir, `${a}.jsonl`), '{}');
        writeFileSync(join(dir, `${b}.jsonl`), '{}');
        at(join(dir, `${a}.jsonl`), 1_000_000_000);
        at(join(dir, `${b}.jsonl`), 1_000_000_000);
        const first = readdirSync(dir)[0]!.replace('.jsonl', '');
        expect(await sessionId()).toBe(first);
    });

    it('invents a sess_ id of 16 url-safe characters when there is no transcript', async () => {
        expect(await sessionId()).toMatch(/^sess_[A-Za-z0-9_-]{16}$/);
    });
});

/** The pids of one chain: [self, parent, grandparent, …]; `panes` maps a pid to its tmux session. */
const runner = (panes: Record<number, string>, parentOf: Record<number, number | string>): CommandRunner => (cmd, args) => {
    if (cmd === 'tmux' && args[0] === 'list-panes') return Object.entries(panes).map(([pid, name]) => `${pid} ${name}`).join('\n');
    if (cmd === 'ps') return `${parentOf[Number(args[args.length - 1])] ?? ''}\n`;
    return null;
};

describe('the pane search up the process tree', () => {
    afterEach(() => vi.unstubAllEnvs());
    const chain = (length: number): Record<number, number> => {
        const parents: Record<number, number> = {};
        let pid = process.pid;
        for (let i = 1; i <= length; i++) {
            parents[pid] = 700_000 + i;
            pid = 700_000 + i;
        }
        return parents;
    };

    it('finds a pane 7 hops above this process', () => {
        vi.stubEnv('TMUX', '');
        expect(detectTmuxSessionName(runner({ 700_007: 'hwip-seven' }, chain(8)))).toBe('hwip-seven');
    });

    it('gives up on a pane 8 hops above: that is some unrelated ancestor', () => {
        vi.stubEnv('TMUX', '');
        expect(detectTmuxSessionName(runner({ 700_008: 'hwip-eight' }, chain(9)))).toBeUndefined();
    });

    it('matches the pane of this process itself', () => {
        vi.stubEnv('TMUX', '');
        expect(detectTmuxSessionName(runner({ [process.pid]: 'hwip-self' }, {}))).toBe('hwip-self');
    });

    it('does not walk into pid 1, even when a pane claims it', () => {
        vi.stubEnv('TMUX', '');
        expect(detectTmuxSessionName(runner({ 1: 'hwip-init' }, { [process.pid]: 1 }))).toBeUndefined();
    });

    it('walks into pid 2 (the first pid it accepts)', () => {
        vi.stubEnv('TMUX', '');
        expect(detectTmuxSessionName(runner({ 2: 'hwip-two' }, { [process.pid]: 2 }))).toBe('hwip-two');
    });

    it('stops at a parent that is not a pid', () => {
        vi.stubEnv('TMUX', '');
        expect(detectTmuxSessionName(runner({ 5: 'hwip-x' }, { [process.pid]: 'not-a-pid', 0: 5 }))).toBeUndefined();
    });

    it('keeps a session name with spaces whole', () => {
        vi.stubEnv('TMUX', '');
        expect(detectTmuxSessionName(runner({ [process.pid]: 'my project' }, {}))).toBe('my project');
    });
});
