import { readFileSync } from 'fs';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServerConfig } from './config.js';
import { HookResponseWaiter } from './ws-wait.js';
import { HwipApiClient } from './api-client.js';
import { registerNotifyTool } from './tools/notify.js';
import { registerClipboardTool } from './tools/clipboard.js';
import { registerListTool } from './tools/list.js';
import { registerDismissTool, registerDismissAllTool } from './tools/dismiss.js';
import { registerBroadcastTool } from './tools/broadcast.js';
import { registerFileTool } from './tools/file.js';
import { registerAskTool } from './tools/ask.js';
import { execHwip, registerAgentListTool, registerAgentReadTool } from './tools/agent-local.js';
import { registerRenameTool } from './tools/rename.js';
import { registerTitleTool, TITLE_INSTRUCTION } from './tools/title.js';
import { registerAgentSendTool } from './tools/agent-send.js';
import { registerLookupTools } from './tools/lookup.js';
import { registerDevicesResource } from './resources/devices.js';
import { registerChannelsResource } from './resources/channels.js';

const getVersion = (): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

export const createServer = (config: McpServerConfig) => {
  const client = new HwipApiClient(config);
  // Shared WS fast path for hwip_ask waits — degrades to
  // pure polling when wsUrl or the WebSocket global is missing (§S3).
  const waiter = new HookResponseWaiter({ wsUrl: config.wsUrl, apiKey: config.apiKey });

  const server = new McpServer(
    {
      name: 'hwip',
      version: getVersion(),
    },
    {
      instructions: [
        'Hwip sends pushes, files, and clipboard text to the user\'s devices.',
        'Questions for the user\'s phone go through hwip_ask (needs HWIP_HOOK_ID).',
        'Resources: hwip://devices (online devices), hwip://channels (broadcast targets).',
        ...(config.autoName ? [TITLE_INSTRUCTION] : []),
      ].join('\n'),
    },
  );

  registerNotifyTool(server, client, config);
  registerClipboardTool(server, client, config);
  registerListTool(server, client);
  registerDismissTool(server, client);
  registerDismissAllTool(server, client);
  registerBroadcastTool(server, client, config);
  registerFileTool(server, client, config);
  registerAskTool(server, client, config, waiter);
  registerRenameTool(server, client, config);
  if (config.autoName) registerTitleTool(server, client, config);
  registerAgentSendTool(server, client, config);
  registerAgentListTool(server, execHwip, client, config);
  registerAgentReadTool(server);
  registerLookupTools(server, client);
  registerDevicesResource(server, client);
  registerChannelsResource(server, client);

  return server;
};
