import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HwipApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';
import type { McpServerConfig } from '../config.js';

// Mirrors the server cap (hwip apps/server/src/functions/devices.ts).
const MAX_ALIAS_LENGTH = 60;

export const registerRenameTool = (server: McpServer, client: HwipApiClient, config: McpServerConfig) => {
  server.registerTool(
    'hwip_session_rename',
    {
      description:
        "Set a custom display name for THIS agent session in the user's Hwip app (the Streams › Agents list). " +
        'Label what this session is working on — e.g. "Prod deploy" or "Auth refactor" — so the user can tell ' +
        'parallel sessions apart on their phone. Renames the current session; the name persists until changed.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        alias: z
          .string()
          .trim()
          .min(1)
          .max(MAX_ALIAS_LENGTH)
          .describe(`Display name for this session (max ${MAX_ALIAS_LENGTH} characters).`),
      },
    },
    async ({ alias }) => {
      try {
        const { agentDeviceId, agentSessionName } = config;
        // The session key is resolved once at startup from the listener device
        // id + tmux session name. Absent it, there is nothing to rename.
        if (!agentDeviceId || !agentSessionName) {
          return textResult({
            renamed: false,
            reason:
              'No active agent session detected — this tool renames the tmux session it runs in, which requires `hwip listener` and a tmux session.',
          });
        }
        await client.renameAgentSession(agentDeviceId, agentSessionName, alias);
        return textResult({ renamed: true, session: agentSessionName, alias });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
