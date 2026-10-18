import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { HwipApiClient } from '../api-client.js';

export const registerChannelsResource = (server: McpServer, client: HwipApiClient) => {
  server.registerResource(
    'channels',
    'hwip://channels',
    {
      title: 'Channels',
      description: 'List of channels the user owns or subscribes to. Use to find channelId for broadcasting.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      try {
        const response = await client.listChannels();
        return {
          contents: [{ uri: uri.href, text: JSON.stringify(response.data, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch channels';
        return {
          contents: [{ uri: uri.href, text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
};
