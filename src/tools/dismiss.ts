import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HwipApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';

export const registerDismissTool = (server: McpServer, client: HwipApiClient) => {
  server.registerTool(
    'hwip_dismiss',
    {
      description:
        'Dismiss (mark as read) a specific push notification by ID. Use after processing a notification to clear it from the user\'s feed.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        pushId: z.string().describe('Push ID to dismiss (e.g., "push_01HX...")'),
      },
    },
    async ({ pushId }) => {
      try {
        await client.dismissPush(pushId);
        return textResult({ dismissed: true, pushId });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};

export const registerDismissAllTool = (server: McpServer, client: HwipApiClient) => {
  server.registerTool(
    'hwip_dismiss_all',
    {
      description:
        'Dismiss all push notifications at once. Clears the entire notification feed.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.dismissAllPushes();
        return textResult({ dismissed: result.data.dismissed, badge: result.data.badge ?? 0 });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
