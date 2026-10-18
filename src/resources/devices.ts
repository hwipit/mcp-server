import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { HwipApiClient } from '../api-client.js';

export const registerDevicesResource = (server: McpServer, client: HwipApiClient) => {
  server.registerResource(
    'devices',
    'hwip://devices',
    {
      title: 'Connected Devices',
      description: 'List of user devices connected to Hwip with online status',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      try {
        const response = await client.listDevices();
        return {
          contents: [{ uri: uri.href, text: JSON.stringify(response.data, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch devices';
        return {
          contents: [{ uri: uri.href, text: JSON.stringify({ error: message }) }],
        };
      }
    },
  );
};
