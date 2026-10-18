/**
 * Point every test at a throwaway home before any of them runs.
 *
 * The trust pins, the key-change record and the device keys live under `~/.hwip`, at paths fixed when a module loads.
 * A tool test that does not mock them would pin into the developer's own trust file, or take — and delete — the
 * key changes the cli and the plugin were keeping for them. A file that wants its own directory still assigns one in
 * its module body or `beforeEach`, which runs after this and wins.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'hwip-mcp-test-home-'));

process.env.HOME = sandbox;
process.env.XDG_STATE_HOME = join(sandbox, 'state');
process.env.XDG_CONFIG_HOME = join(sandbox, 'config');
