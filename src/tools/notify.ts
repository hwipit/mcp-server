import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HwipApiClient } from '../api-client.js';
import { textResult, errorResult, formatToolError } from '../error-format.js';
import { notingKeyChanges } from '../key-changes.js';
import { formatPushTitle, type McpServerConfig } from '../config.js';
import { encryptPushBodyForDevices, encryptFileForDevices, type DeviceRecipient } from '../crypto.js';
import { E2E_REQUIRED, resolveAudience, sealFailed } from '../push-audience.js';
import { inferMimeType } from '../mime.js';
import { sanitizeText } from '../sanitize.js';

// The device feed shows a short preview of the body. Anything longer gets
// truncated there, so we attach the full text as a file for full viewing.
const PREVIEW_LENGTH = 200;

export const registerNotifyTool = (server: McpServer, client: HwipApiClient, config: McpServerConfig) => {
  server.registerTool(
    'hwip_notify',
    {
      description:
        'Send a one-way push notification to the user\'s devices. Use this to inform the user about task completion, errors, or status updates. Long bodies are automatically uploaded as a file for full viewing.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        title: z.string().describe('Notification title'),
        body: z.string().optional().describe('Notification body text'),
        url: z.string().url().optional().describe('Optional URL to open on the device.'),
        priority: z
          .enum(['low', 'normal', 'high', 'urgent'])
          .default('normal')
          .describe('Notification priority. Use "urgent" for critical alerts, "low" for background info.'),
        targetDeviceId: z.string().optional().describe('Target device ID. Omit to use configured default or send to all devices.'),
      },
    },
    notingKeyChanges(async ({ title, body, url, priority, targetDeviceId }) => {
      const send = async (recipients: DeviceRecipient[]) => {
        const deviceId = targetDeviceId ?? config.deviceId;
        const pushTitle = formatPushTitle(config.projectName, title);
        // Strip any tool-call markup that leaked into the body argument.
        const cleanBody = sanitizeText(body);
        // Attach a file whenever the body would be clipped in the feed preview.
        const isLongBody = !!cleanBody && cleanBody.length > PREVIEW_LENGTH;

        if (isLongBody && cleanBody) {
          const fileName = 'response.md';
          const fileType = inferMimeType(fileName);

          // Self-contained Markdown so the file alone carries the full text.
          const fileMarkdown = `# ${title}\n\n${cleanBody}`;
          const fileBytes = new TextEncoder().encode(fileMarkdown).byteLength;

          const preview = cleanBody.slice(0, PREVIEW_LENGTH) + '...';

          // Seal the attachment and the push body together, before anything is
          // uploaded: a failure in between would leave ciphertext under no push.
          let sealed: {
            file: Awaited<ReturnType<typeof encryptFileForDevices>>;
            push: Awaited<ReturnType<typeof encryptPushBodyForDevices>>;
          };
          try {
            sealed = {
              file: await encryptFileForDevices(fileMarkdown, recipients),
              push: await encryptPushBodyForDevices({ title: pushTitle, body: preview, url }, recipients),
            };
          } catch (err) {
            console.error('[Crypto] Sealing the notification failed:', err);
            return errorResult({ error: E2E_REQUIRED, message: sealFailed('sealing the notification failed') });
          }

          const uploadContentType = 'application/octet-stream';
          const upload = await client.requestUpload({ fileName, fileType: uploadContentType, fileSize: sealed.file.ciphertext.length });
          await client.uploadToS3(upload.data.uploadUrl, sealed.file.ciphertext, uploadContentType);

          // No title or url beside the envelope: `isEncrypted` promises the server sees neither.
          const pushPayload: Record<string, unknown> = {
            body: sealed.push.body,
            type: 'file',
            priority,
            files: [{
              fileKey: upload.data.fileKey,
              fileName,
              fileSize: fileBytes,
              fileType,
              iv: sealed.file.iv,
              deviceKeyMap: sealed.file.deviceKeyMap,
            }],
            targetDeviceId: deviceId,
            sessionId: config.sessionId,
            isEncrypted: sealed.push.isEncrypted,
            deviceKeyMap: sealed.push.deviceKeyMap,
            senderPublicKey: sealed.push.senderPublicKey,
          };

          const result = await client.sendPush(pushPayload as Parameters<typeof client.sendPush>[0]);
          return textResult({ pushId: result.data.pushId, fileKey: upload.data.fileKey, autoFile: true, encrypted: true });
        }

        let enc: Awaited<ReturnType<typeof encryptPushBodyForDevices>>;
        try {
          enc = await encryptPushBodyForDevices({ title: pushTitle, body: cleanBody, url }, recipients);
        } catch (err) {
          console.error('[Crypto] Sealing the notification failed:', err);
          return errorResult({ error: E2E_REQUIRED, message: sealFailed('sealing the notification failed') });
        }
        const pushPayload: Record<string, unknown> = {
          body: enc.body,
          type: 'hook',
          priority,
          targetDeviceId: deviceId,
          sessionId: config.sessionId,
          isEncrypted: enc.isEncrypted,
          deviceKeyMap: enc.deviceKeyMap,
          senderPublicKey: enc.senderPublicKey,
        };

        const result = await client.sendPush(pushPayload as Parameters<typeof client.sendPush>[0]);
        return textResult({ pushId: result.data.pushId, encrypted: true });
      };

      try {
        const audience = await resolveAudience(client);
        if ('refused' in audience) return errorResult({ error: audience.code, message: audience.refused });
        return await send(audience.recipients);
      } catch (err) {
        return formatToolError(err);
      }
    }),
  );
};
