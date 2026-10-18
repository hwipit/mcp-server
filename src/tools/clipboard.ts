import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HwipApiClient } from '../api-client.js';
import { errorResult, textResult, formatToolError } from '../error-format.js';
import type { McpServerConfig } from '../config.js';

/**
 * The server's push body cap (hwip `server/src/lib/push-input.ts` `MAX_BODY_BYTES`), measured
 * the same way: the body's JSON text in UTF-8, escapes included, the quotes not.
 */
const MAX_BODY_BYTES = 96 * 1024;

export const registerClipboardTool = (server: McpServer, client: HwipApiClient, config: McpServerConfig) => {
  server.registerTool(
    'hwip_clipboard',
    {
      description:
        'Copy text to the user\'s device clipboard. The text will appear in their clipboard history and can be pasted immediately. At most 96 KiB (as JSON text); send longer text with hwip_file. Not end-to-end encrypted — do not use it for secrets (keys, tokens, passwords); use hwip_notify or hwip_file for those.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        text: z.string().describe('Text to copy to clipboard'),
        targetDeviceId: z.string().optional().describe('Target device ID. Omit to use configured default or send to all devices.'),
      },
    },
    async ({ text, targetDeviceId }) => {
      const bytes = Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
      if (bytes > MAX_BODY_BYTES) {
        return errorResult({
          error: 'BODY_TOO_LONG',
          message: `Clipboard text is ${bytes} bytes as JSON; the server takes at most ${MAX_BODY_BYTES}`,
          suggestion: 'Send it with hwip_file (content) instead, or copy a shorter part',
        });
      }
      try {
        const result = await client.sendPush({
          title: 'Clipboard',
          body: text,
          type: 'clipboard',
          targetDeviceId: targetDeviceId ?? config.deviceId,
          sessionId: config.sessionId,
        });
        return textResult({ pushId: result.data.pushId });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
