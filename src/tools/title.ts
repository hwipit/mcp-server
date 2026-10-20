import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApiError, type HwipApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';
import type { McpServerConfig } from '../config.js';

/** Short enough to read at a glance in the phone's session list. The server takes up to 60. */
const MAX_TITLE_LENGTH = 40;

/**
 * The always-loaded line that tells the agent when to call the tool — only
 * sent when the tool is. Same wording as the pi extension's guideline
 * (cli templates.ts), so every self-naming agent is told the same thing.
 */
export const TITLE_INSTRUCTION =
  "Name this session with hwip_session_title after the first request, and again only when the task changes: " +
  `what it does (verb + object), in the user's language, at most ${MAX_TITLE_LENGTH} characters. Do not mention it to the user.`;

/**
 * The name an agent gives its own session (`agentSessionAutoNames`) — for
 * agents with no session title of their own. Unlike `hwip_session_rename`
 * this is not the user's alias: the alias still wins, and the user's "auto
 * session names" setting can hide it. Registered only with HWIP_AUTONAME.
 */
export const registerTitleTool = (server: McpServer, client: HwipApiClient, config: McpServerConfig) => {
  server.registerTool(
    'hwip_session_title',
    {
      description:
        "Title THIS session in the user's Hwip app with what it is working on, so the user can tell sessions apart. " +
        `A few words in the user's language, at most ${MAX_TITLE_LENGTH} characters. A name the user gave the session still shows over it.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        title: z
          .string()
          .trim()
          .min(1)
          .max(MAX_TITLE_LENGTH)
          .describe(`What this session is doing (max ${MAX_TITLE_LENGTH} characters).`),
      },
    },
    async ({ title }) => {
      const { agentDeviceId, agentSessionName } = config;
      if (!agentDeviceId || !agentSessionName) {
        return textResult({
          titled: false,
          reason: 'No agent session detected — titling needs `hwip listener` and a tmux session.',
        });
      }
      try {
        await client.setAgentSessionAutoName(agentDeviceId, agentSessionName, title);
        return textResult({ titled: true, session: agentSessionName, title });
      } catch (err) {
        // A title the server will not take (the listener has not reported this
        // session yet: 400; a server without the route or the device: 404)
        // costs the user nothing — say so instead of failing the turn.
        if (err instanceof ApiError && (err.status === 400 || err.status === 404)) {
          return textResult({ titled: false, reason: err.message });
        }
        return formatToolError(err);
      }
    },
  );
};
