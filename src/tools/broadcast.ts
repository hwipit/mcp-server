import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HwipApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';
import type { McpServerConfig } from '../config.js';

export const registerBroadcastTool = (server: McpServer, client: HwipApiClient, config: McpServerConfig) => {
  server.registerTool(
    'hwip_broadcast',
    {
      description:
        'Send a push notification to all subscribers of a channel. Use hwip_channels to find available channels.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        channelId: z.string().describe('Channel ID to broadcast to (e.g., "ch_...")'),
        title: z.string().describe('Notification title'),
        body: z.string().optional().describe('Notification body text'),
        url: z.string().url().optional().describe('Optional URL to open on the device.'),
        priority: z
          .enum(['low', 'normal', 'high', 'urgent'])
          .default('normal')
          .describe('Notification priority'),
      },
    },
    async ({ channelId, title, body, url, priority }) => {
      try {
        const result = await client.sendPush({
          title,
          body,
          url,
          type: 'hook',
          priority,
          channelId,
          sessionId: config.sessionId,
        });
        return textResult({ pushId: result.data.pushId, channelId });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
