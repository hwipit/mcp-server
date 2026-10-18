import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiError } from './api-client.js';
import { AskError } from './poll.js';
import type { ToolError } from './types.js';

export const textResult = (obj: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
});

export const errorResult = (obj: ToolError): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  isError: true,
});

export const hookNotConfiguredError = (): CallToolResult =>
  errorResult({
    error: 'HOOK_NOT_CONFIGURED',
    message: 'No hook id: neither HWIP_HOOK_ID nor hookId in ~/.hwip/config.json is set, so a question cannot reach the phone',
    suggestion:
      'Ask in this chat instead, and use hwip_notify if the user should be pinged about it. '
      + 'To enable hwip_ask, the user runs `hwip login` (it writes hookId to ~/.hwip/config.json) or sets HWIP_HOOK_ID.',
  });

/** What the agent should do after each way an ask can end unanswered. */
const ASK_SUGGESTIONS: Record<AskError['code'], string> = {
  CANCELLED: 'The user dismissed this question on purpose. Do not ask it again — carry on without it, or ask something different.',
  POLL_FAILED: 'Do not re-ask blindly — the question may still be on the phone and a repeat pushes a duplicate. Tell the user in the terminal what you were waiting on.',
  ABORTED: 'The tool call was cancelled before the user answered.',
};

export const formatToolError = (err: unknown): CallToolResult => {
  const toolError: ToolError = {
    error: 'UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
  };

  if (err instanceof AskError) {
    toolError.error = err.code;
    if (err.eventId) toolError.eventId = err.eventId;
    toolError.suggestion = ASK_SUGGESTIONS[err.code];
  } else if (err instanceof ApiError) {
    toolError.error = err.code;
    toolError.message = err.message;

    if (err.code === 'QUOTA_EXCEEDED') {
      toolError.suggestion = 'Monthly quota exceeded. Upgrade plan for higher limits';
    } else if (err.code === 'UNAUTHORIZED') {
      toolError.suggestion = 'Check HWIP_API_KEY environment variable or ~/.hwip/config.json';
    } else if (err.code === 'HOOK_DISABLED') {
      toolError.suggestion = 'Enable the Hook in Settings → Hooks';
    } else if (err.code === 'NETWORK_ERROR') {
      toolError.suggestion = err.causeCode === 'ERR_INVALID_URL'
        ? 'Do not retry. The configured API base URL is not an address; the user has to correct HWIP_BASE_URL (or baseUrl in ~/.hwip/config.json)'
        : 'No connection to the hwip API. Retry once later; if it keeps failing, carry on in the chat';
    } else if (err.code === 'INVALID_UPLOAD_URL') {
      toolError.suggestion = 'Do not retry, and do not correct HWIP_BASE_URL for it — the upload address came from the hwip API\'s own reply, not from the configuration. Tell the user in the terminal which file was not uploaded';
    } else if (err.code === 'REDIRECT_REFUSED') {
      toolError.suggestion = 'Do not retry. The configured API base URL redirects somewhere else; the user has to correct HWIP_BASE_URL (or baseUrl in ~/.hwip/config.json)';
    } else if (err.code === 'API_TIMEOUT') {
      toolError.suggestion = 'The hwip API was slow, not the user. If this was a send, check hwip_list before sending again — it may have gone out';
    } else if (err.code === 'BAD_RESPONSE') {
      toolError.suggestion = 'The answer was not the hwip API\'s own reply. If this was a send, check hwip_list before sending again — it may have gone out';
    } else if (err.code === 'SEND_UNCONFIRMED') {
      toolError.suggestion = 'Check hwip_list before asking again — the question may have gone out';
    } else if (err.code === 'FORBIDDEN') {
      toolError.suggestion = 'Check the API key scopes — a key made with the MCP preset covers every tool';
    }
  }

  return errorResult(toolError);
};
