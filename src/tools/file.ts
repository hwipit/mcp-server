import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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

/** The most files one push carries: the server's `MAX_FILES_PER_PUSH`. More go out as several pushes. */
export const MAX_FILES_PER_PUSH = 5;

/** The most paths one call takes; a screen's worth of pushes, not a folder dumped on the phone. */
const MAX_FILE_PATHS = 20;

/**
 * Look before reading: the file lands in memory whole, so a directory or an oversize path must be turned
 * away while it is still just a path.
 */
const checkPath = async (filePath: string) => {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`${filePath} is not a regular file`);
  if (info.size > MAX_FILE_BYTES) throw new FileTooLargeError(info.size);
};

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
    await checkPath(args.filePath);
    const body = await readFile(args.filePath);
    return { fileName: args.fileName ?? basename(args.filePath), body, size: body.byteLength };
  }
  return {
    fileName: args.fileName!,
    body: args.content!,
    size: new TextEncoder().encode(args.content!).byteLength,
  };
};

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

const readFailure = (err: unknown) => {
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
    suggestion: 'Check that every path is an absolute path to a readable file',
  });
};

export const registerFileTool = (server: McpServer, client: HwipApiClient, config: McpServerConfig) => {
  /**
   * Seals the files and the title together, uploads the files, then sends the one push that carries them. Sealing
   * comes before any upload: a failure in between would leave ciphertext under no push.
   */
  type Sent = { refused: CallToolResult } | { pushId: string; fileKeys: string[] };
  const sendOne = async (
    payloads: FilePayload[],
    pushTitle: string,
    recipients: DeviceRecipient[],
    target: string | undefined,
  ): Promise<Sent> => {
    let sealed: {
      files: Awaited<ReturnType<typeof encryptFileForDevices>>[];
      push: Awaited<ReturnType<typeof encryptPushBodyForDevices>>;
    };
    try {
      const files = [];
      for (const payload of payloads) files.push(await encryptFileForDevices(payload.body, recipients));
      sealed = { files, push: await encryptPushBodyForDevices({ title: pushTitle }, recipients) };
    } catch (err) {
      console.error('[Crypto] Sealing the file failed:', err);
      return { refused: errorResult({ error: E2E_REQUIRED, message: sealFailed('sealing the file failed') }) };
    }

    const uploadType = 'application/octet-stream';
    const attached = [];
    for (const [i, payload] of payloads.entries()) {
      const file = sealed.files[i];
      const upload = await client.requestUpload({ fileName: payload.fileName, fileType: uploadType, fileSize: file.ciphertext.length });
      await client.uploadToS3(upload.data.uploadUrl, file.ciphertext, uploadType);
      // `fileType` on the descriptor stays the real type — it drives how the client renders the decrypted bytes.
      attached.push({
        fileKey: upload.data.fileKey,
        fileName: payload.fileName,
        fileSize: payload.size,
        fileType: inferMimeType(payload.fileName),
        iv: file.iv,
        deviceKeyMap: file.deviceKeyMap,
      });
    }

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
      files: attached,
    });
    return { pushId: result.data.pushId, fileKeys: attached.map((f) => f.fileKey) };
  };

  server.registerTool(
    'hwip_file',
    {
      description:
        'Send files to the user\'s device. Pass `filePath` to send a file that already exists on disk — images (png/jpg/gif/webp/heic), PDFs, logs, anything. Pass `filePaths` to send several at once (screenshots of one change, a set of logs): they arrive together in one message, five to a push. Pass `content` instead to send text you generated. Images render inline on the device.',
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
        filePaths: z
          .array(z.string())
          .min(1)
          .max(MAX_FILE_PATHS)
          .optional()
          .describe(`Absolute paths of several local files to send together, in order (up to ${MAX_FILE_PATHS}). Use instead of one call per file. Not with \`filePath\` or \`content\`.`),
        content: z.string().optional().describe('Text content of the file. Use only for text you generated; requires `fileName`.'),
        fileName: z
          .string()
          .optional()
          .describe('File name with extension (e.g., "report.txt"). Required with `content`; defaults to the basename of `filePath`.'),
        title: z.string().optional().describe('Notification title (defaults to fileName, or the number of files)'),
        targetDeviceId: z.string().optional().describe('Target device ID. Omit to use configured default or send to all devices.'),
      },
    },
    notingKeyChanges(async ({ filePath, filePaths, fileName: fileNameArg, content, title, targetDeviceId }, extra) => {
      if (filePaths && (filePath || content !== undefined)) {
        return errorResult({
          error: 'INVALID_INPUT',
          message: 'filePaths goes alone, not with filePath or content',
          suggestion: 'Put every path in filePaths, or send the generated text in a call of its own',
        });
      }
      if (!filePaths && !filePath && content === undefined) {
        return errorResult({
          error: 'INVALID_INPUT',
          message: 'Either filePath, filePaths or content is required',
          suggestion: 'Pass filePath (or filePaths) for files on disk (images, PDFs), or content + fileName for generated text',
        });
      }
      if (!filePaths && !filePath && !fileNameArg) {
        return errorResult({
          error: 'INVALID_INPUT',
          message: 'fileName is required when sending content',
          suggestion: 'Add fileName with an extension, e.g. "report.md"',
        });
      }

      const target = targetDeviceId ?? config.deviceId;

      if (filePaths) {
        // Every path is looked at before anything is read or sent: one bad path sends none, not some.
        try {
          for (const path of filePaths) await checkPath(path);
        } catch (err) {
          return readFailure(err);
        }
        const groups = chunks(filePaths, MAX_FILES_PER_PUSH);
        const named = title ?? (filePaths.length === 1 ? basename(filePaths[0]) : `${filePaths.length} files`);
        try {
          const audience = await resolveAudience(client);
          if ('refused' in audience) return errorResult({ error: audience.code, message: audience.refused });
          const pushIds: string[] = [];
          for (const [i, group] of groups.entries()) {
            // An agent that abandoned the call abandoned the rest of the send.
            if (extra?.signal?.aborted) {
              return errorResult({ error: 'CANCELLED', message: `The send was cancelled after ${pushIds.length} of ${groups.length} pushes` });
            }
            let payloads: FilePayload[];
            try {
              payloads = [];
              for (const path of group) payloads.push(await resolvePayload({ filePath: path }));
            } catch (err) {
              return readFailure(err);
            }
            const part = groups.length > 1 ? ` (${i + 1}/${groups.length})` : '';
            const sent = await sendOne(payloads, formatPushTitle(config.projectName, named + part), audience.recipients, target);
            if ('refused' in sent) return sent.refused;
            pushIds.push(sent.pushId);
          }
          return textResult({ pushIds, fileCount: filePaths.length, encrypted: true, delivery: 'Sent via cloud' });
        } catch (err) {
          return formatToolError(err);
        }
      }

      let payload: FilePayload;
      try {
        payload = await resolvePayload({ filePath, content, fileName: fileNameArg });
      } catch (err) {
        return readFailure(err);
      }

      try {
        const audience = await resolveAudience(client);
        if ('refused' in audience) return errorResult({ error: audience.code, message: audience.refused });
        // An agent that abandoned the call abandoned the send.
        if (extra?.signal?.aborted) {
          return errorResult({ error: 'CANCELLED', message: 'The send was cancelled before the file went out' });
        }
        const sent = await sendOne([payload], formatPushTitle(config.projectName, title ?? payload.fileName), audience.recipients, target);
        if ('refused' in sent) return sent.refused;
        return textResult({
          pushId: sent.pushId,
          fileKey: sent.fileKeys[0],
          fileSize: payload.size,
          encrypted: true,
          delivery: 'Sent via cloud',
        });
      } catch (err) {
        return formatToolError(err);
      }
    }),
  );
};
