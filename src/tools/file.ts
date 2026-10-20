import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_FILE_BYTES, type HwipApiClient } from '../api-client.js';
import { formatPushTitle, type McpServerConfig } from '../config.js';
import { textResult, errorResult, formatToolError } from '../error-format.js';
import { notingKeyChanges } from '../key-changes.js';
import { encryptPushBodyForDevices, encryptFileForDevices, type DeviceRecipient } from '../crypto.js';
import { E2E_REQUIRED, resolveAudience, sealFailed } from '../push-audience.js';
import { inferMimeType } from '../mime.js';

class FileTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`File is ${size} bytes; the most hwip carries is ${MAX_FILE_BYTES}`);
  }
}

type FilePayload = { fileName: string; body: string | Buffer; size: number };

/**
 * Collapse the two accepted input shapes into one payload.
 *
 * A `filePath` stays a Buffer end to end — images and PDFs only survive the
 * trip as raw bytes, and reading from disk keeps a several-hundred-KB
 * attachment out of the tool call itself (base64 in the arguments would
 * inflate it by a third and burn the agent's context).
 */
const resolvePayload = async (args: { filePath?: string; content?: string; fileName?: string }): Promise<FilePayload> => {
  if (args.filePath) {
    // Look before reading: the file lands in memory whole, so a directory or an
    // oversize path must be turned away while it is still just a path.
    const info = await stat(args.filePath);
    if (!info.isFile()) throw new Error(`${args.filePath} is not a regular file`);
    if (info.size > MAX_FILE_BYTES) throw new FileTooLargeError(info.size);
    const body = await readFile(args.filePath);
    return { fileName: args.fileName ?? basename(args.filePath), body, size: body.byteLength };
  }
  return {
    fileName: args.fileName!,
    body: args.content!,
    size: new TextEncoder().encode(args.content!).byteLength,
  };
};

export const registerFileTool = (server: McpServer, client: HwipApiClient, config: McpServerConfig) => {
  server.registerTool(
    'hwip_file',
    {
      description:
        'Send a file to the user\'s device. Pass `filePath` to send a file that already exists on disk — images (png/jpg/gif/webp/heic), PDFs, logs, anything. Pass `content` instead to send text you generated. Images render inline on the device.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        filePath: z
          .string()
          .optional()
          .describe('Absolute path to a local file to send. Required for images, PDFs, and any other binary — never base64 a file into `content`.'),
        content: z.string().optional().describe('Text content of the file. Use only for text you generated; requires `fileName`.'),
        fileName: z
          .string()
          .optional()
          .describe('File name with extension (e.g., "report.txt"). Required with `content`; defaults to the basename of `filePath`.'),
        title: z.string().optional().describe('Notification title (defaults to fileName)'),
        targetDeviceId: z.string().optional().describe('Target device ID. Omit to use configured default or send to all devices.'),
      },
    },
    notingKeyChanges(async ({ filePath, fileName: fileNameArg, content, title, targetDeviceId }, extra) => {
      if (!filePath && content === undefined) {
        return errorResult({
          error: 'INVALID_INPUT',
          message: 'Either filePath or content is required',
          suggestion: 'Pass filePath for a file on disk (images, PDFs), or content + fileName for generated text',
        });
      }
      if (!filePath && !fileNameArg) {
        return errorResult({
          error: 'INVALID_INPUT',
          message: 'fileName is required when sending content',
          suggestion: 'Add fileName with an extension, e.g. "report.md"',
        });
      }

      let payload: FilePayload;
      try {
        payload = await resolvePayload({ filePath, content, fileName: fileNameArg });
      } catch (err) {
        if (err instanceof FileTooLargeError) {
          return errorResult({
            error: 'FILE_TOO_LARGE',
            message: err.message,
            suggestion: 'Send a smaller file, or an archive of the part the user needs. Free accounts send up to 25 MiB, Pro up to 1 GiB',
          });
        }
        return errorResult({
          error: 'FILE_READ_FAILED',
          message: err instanceof Error ? err.message : String(err),
          suggestion: 'Check that filePath is an absolute path to a readable file',
        });
      }
      const { fileName, body, size: originalSize } = payload;

      // The whole upload-then-send sequence sits in this closure so the file is
      // sealed for the same audience as the push that carries it.
      const send = async (recipients: DeviceRecipient[]) => {
        const pushTitle = formatPushTitle(config.projectName, title ?? fileName);

        const target = targetDeviceId ?? config.deviceId;
        const fileType = inferMimeType(fileName);

        // An agent that abandoned the call abandoned the send.
        if (extra?.signal?.aborted) {
          return errorResult({ error: 'CANCELLED', message: 'The send was cancelled before the file went out' });
        }

        // Step 1: Seal the attachment and the push body together, before
        // anything is uploaded: a failure in between would leave ciphertext
        // under no push.
        let sealed: {
          file: Awaited<ReturnType<typeof encryptFileForDevices>>;
          push: Awaited<ReturnType<typeof encryptPushBodyForDevices>>;
        };
        try {
          sealed = {
            file: await encryptFileForDevices(body, recipients),
            push: await encryptPushBodyForDevices({ title: pushTitle }, recipients),
          };
        } catch (err) {
          console.error('[Crypto] Sealing the file failed:', err);
          return errorResult({ error: E2E_REQUIRED, message: sealFailed('sealing the file failed') });
        }

        const uploadType = 'application/octet-stream';

        // Step 2: Request upload URL
        const upload = await client.requestUpload({ fileName, fileType: uploadType, fileSize: sealed.file.ciphertext.length });

        // Step 3: Upload content to S3
        await client.uploadToS3(upload.data.uploadUrl, sealed.file.ciphertext, uploadType);

        // Step 4: Send the push. `fileType` on the descriptor stays the real
        // type — it drives how the client renders the decrypted bytes.
        // Thread with the tmux session key, not just sessionId: a Claude UUID
        // scan picks the newest transcript in the project, so a sibling agent
        // in the same repo would get this file in its chat.
        const result = await client.sendPush({
          type: 'file',
          targetDeviceId: target,
          sessionId: config.sessionId,
          ...(config.agentDeviceId ? { agentDeviceId: config.agentDeviceId } : {}),
          ...(config.agentSessionName ? { agentSessionName: config.agentSessionName } : {}),
          body: sealed.push.body,
          isEncrypted: sealed.push.isEncrypted,
          deviceKeyMap: sealed.push.deviceKeyMap,
          senderPublicKey: sealed.push.senderPublicKey,
          files: [{
            fileKey: upload.data.fileKey,
            fileName,
            fileSize: originalSize,
            fileType,
            iv: sealed.file.iv,
            deviceKeyMap: sealed.file.deviceKeyMap,
          }],
        });
        return textResult({
          pushId: result.data.pushId,
          fileKey: upload.data.fileKey,
          fileSize: originalSize,
          encrypted: true,
          delivery: 'Sent via cloud',
        });
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
