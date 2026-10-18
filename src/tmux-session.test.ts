import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectTmuxSessionName, type CommandRunner } from './config.js';

/**
 * Repro for: an agent that spawns its MCP servers with a sanitized environment
 * (codex-cli 0.154.0 — measured) leaves this process with no TMUX, so the push
 * lost its agent-session key and the phone opened the plain push screen instead
 * of the agent chat with its live terminal.
 */
const runner = (panes: string, parents: Record<number, number>): CommandRunner =>
    (cmd, args) => {
        if (cmd === 'tmux' && args[0] === 'list-panes') return panes;
        if (cmd === 'tmux' && args[0] === 'display-message') return 'hwip-from-env\n';
        if (cmd === 'ps') {
            const pid = Number(args[args.length - 1]);
            return parents[pid] ? `${parents[pid]}\n` : '';
        }
        return null;
    };

describe('detectTmuxSessionName', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('finds the pane session through the process tree when TMUX was stripped', () => {
        vi.stubEnv('TMUX', '');
        // this process → codex pane (which owns the pane, two hops up)
        const parents = { [process.pid]: 4242, 4242: 1000 };
        const name = detectTmuxSessionName(runner('1000 hwip-dotfiles\n2000 hwip-other', parents));
        expect(name).toBe('hwip-dotfiles');
    });

    it('prefers the pane the environment names', () => {
        vi.stubEnv('TMUX', '/private/tmp/tmux-501/default,1,0');
        expect(detectTmuxSessionName(runner('1000 hwip-dotfiles', {}))).toBe('hwip-from-env');
    });

    it('stays undefined when no ancestor owns a pane', () => {
        vi.stubEnv('TMUX', '');
        expect(detectTmuxSessionName(runner('1000 hwip-dotfiles', {}))).toBeUndefined();
    });

    it('stays undefined when tmux is not running', () => {
        vi.stubEnv('TMUX', '');
        expect(detectTmuxSessionName(() => null)).toBeUndefined();
    });
});
