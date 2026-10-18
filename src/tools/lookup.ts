import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HwipApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';

/**
 * Read-only lookups for the ids `hwip_notify` takes (`targetDeviceId`,
 * `channelId`). The same lists are MCP resources, but an agent that only
 * calls tools never reads a resource, so without these it had no way to
 * find an id to target.
 */
export const registerLookupTools = (server: McpServer, client: HwipApiClient) => {
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };

  server.registerTool(
    'hwip_devices',
    {
      description:
        "List the user's devices with their online status. Use a `deviceId` as hwip_notify's `targetDeviceId` to reach one device.",
      annotations: readOnly,
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.listDevices();
        return textResult({ devices: result.data });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.registerTool(
    'hwip_channels',
    {
      description:
        "List the user's channels. Use a `channelId` with hwip_broadcast to reach a channel's subscribers.",
      annotations: readOnly,
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.listChannels();
        return textResult({ channels: result.data });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
