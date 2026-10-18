#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { legacyWsEnvNotice, loadConfig } from './config.js';
import { cryptoStatusLine, initCrypto } from './crypto.js';
import { createServer } from './server.js';
import { wsFastPathNotice } from './ws-wait.js';

const main = async () => {
  const config = loadConfig();

  // Read only to report: the variable used to outrank the config file, and
  // removing it without a word would leave the same silence behind.
  const staleWsEnv = legacyWsEnvNotice();
  if (staleWsEnv) console.error(staleWsEnv);
  const noFastPath = wsFastPathNotice(config.wsUrl);
  if (noFastPath) console.error(noFastPath);

  // Load or create this host's keypair. Runs once per process and caches.
  // Not awaited: a send waits for it instead (`cryptoReady`).
  initCrypto(config.apiKey).then(
    () => console.error(cryptoStatusLine()),
    (err) => console.error('[Crypto] E2E encryption unavailable:', err),
  );

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Hwip MCP Server running on stdio');
};

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
