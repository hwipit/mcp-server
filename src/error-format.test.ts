import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client.js';
import { AskError } from './poll.js';
import {
    textResult,
    errorResult,
    hookNotConfiguredError,
    formatToolError,
} from './error-format.js';

// All MCP tools route errors through formatToolError to produce structured
// CallToolResult payloads with isError set. Each branch maps a server-side
// error code (QUOTA_EXCEEDED, UNAUTHORIZED, etc.) to an actionable
// `suggestion` field the AI can read and surface to the user.

const parseFirstText = (r: { content: Array<{ type: string; text: string }> }) =>
    JSON.parse(r.content[0].text);

describe('textResult', () => {
    it('wraps a JSON-serialized payload as MCP text content', () => {
        const r = textResult({ pushId: 'push_01' });
        expect(r.content).toHaveLength(1);
        expect(r.content[0].type).toBe('text');
        expect(JSON.parse(r.content[0].text)).toEqual({ pushId: 'push_01' });
        expect(r.isError).toBeUndefined();
    });
});

describe('errorResult', () => {
    it('marks isError true and serializes the payload', () => {
        const r = errorResult({ error: 'X', message: 'm' });
        expect(r.isError).toBe(true);
        expect(parseFirstText(r as { content: Array<{ type: string; text: string }> })).toEqual({
            error: 'X',
            message: 'm',
        });
    });
});

describe('hookNotConfiguredError', () => {
    it('names both places a hook id is read from, and what to do meanwhile', () => {
        const r = hookNotConfiguredError();
        expect(r.isError).toBe(true);
        const body = parseFirstText(r as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe('HOOK_NOT_CONFIGURED');
        expect(body.message).toMatch(/HWIP_HOOK_ID/);
        expect(body.message).toContain('~/.hwip/config.json');
        expect(body.suggestion).toMatch(/ask in this chat/i);
        expect(body.suggestion).toMatch(/hwip_notify/);
    });
});

describe('formatToolError', () => {
    it.each([
        ['NETWORK_ERROR', 0, /retry once later/i],
        ['API_TIMEOUT', 408, /check hwip_list before sending again/i],
        ['SEND_UNCONFIRMED', 503, /check hwip_list before asking again/i],
        ['BAD_RESPONSE', 0, /check hwip_list before sending again/i],
    ] as const)('gives %s its own next step', (code, status, hint) => {
        const body = parseFirstText(formatToolError(new ApiError('msg', code, status)) as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe(code);
        expect(body.suggestion).toMatch(hint);
    });

    it.each([
        ['CANCELLED', /do not ask it again/i],
        ['POLL_FAILED', /do not re-ask blindly/i],
        ['ABORTED', /cancelled before/i],
    ] as const)('maps AskError %s to its code, the eventId and a next-step hint', (code, hint) => {
        const r = formatToolError(new AskError(code, 'msg', 'hevt_9'));
        const body = parseFirstText(r as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe(code);
        expect(body.eventId).toBe('hevt_9');
        expect(body.suggestion).toMatch(hint);
    });

    it('passes through ApiError code + message', () => {
        const err = new ApiError('boom', 'SOMETHING_BAD', 500);
        const r = formatToolError(err);
        const body = parseFirstText(r as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe('SOMETHING_BAD');
        expect(body.message).toBe('boom');
    });

    it('adds QUOTA_EXCEEDED upgrade suggestion', () => {
        const err = new ApiError('over limit', 'QUOTA_EXCEEDED', 403);
        const body = parseFirstText(formatToolError(err) as { content: Array<{ type: string; text: string }> });
        expect(body.suggestion).toMatch(/Upgrade/);
    });

    it('adds UNAUTHORIZED → check HWIP_API_KEY suggestion', () => {
        const err = new ApiError('nope', 'UNAUTHORIZED', 401);
        const body = parseFirstText(formatToolError(err) as { content: Array<{ type: string; text: string }> });
        expect(body.suggestion).toMatch(/HWIP_API_KEY/);
    });

    it('adds HOOK_DISABLED → enable in settings suggestion', () => {
        const err = new ApiError('disabled', 'HOOK_DISABLED', 400);
        const body = parseFirstText(formatToolError(err) as { content: Array<{ type: string; text: string }> });
        expect(body.suggestion).toMatch(/Enable the Hook/);
    });

    it('adds FORBIDDEN → check scopes suggestion', () => {
        const err = new ApiError('forbidden', 'FORBIDDEN', 403);
        const body = parseFirstText(formatToolError(err) as { content: Array<{ type: string; text: string }> });
        expect(body.suggestion).toMatch(/scopes/);
    });

    it('handles unknown Error subclasses as UNKNOWN', () => {
        const err = new Error('something else');
        const body = parseFirstText(formatToolError(err) as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe('UNKNOWN');
        expect(body.message).toBe('something else');
    });

    it('handles non-Error throws by stringifying', () => {
        const body = parseFirstText(formatToolError('plain string') as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe('UNKNOWN');
        expect(body.message).toBe('plain string');
    });
});

// What the transport said goes into the message the client wrote, and nowhere else: the tool result is
// built field by field, so a new field on the error is not one more thing the model reads.
describe('what of an ApiError reaches the tool result', () => {
    it('carries the code, the message and the suggestion, and none of the transport fields', () => {
        const err = new ApiError('Could not reach the hwip API (ECONNRESET).', 'NETWORK_ERROR', 0, { unsent: true, causeCode: 'ECONNRESET' });
        const result = formatToolError(err);
        expect(Object.keys(parseFirstText(result)).sort()).toEqual(['error', 'message', 'suggestion']);
        expect(result.content[0].text).not.toMatch(/unsent|causeCode/);
    });
});

// "Retry once later" is for a network that may come back. An address that is not one will not.
describe('what a base URL that is not an address suggests', () => {
    it('says not to retry, and which setting to correct', () => {
        const err = new ApiError('Could not reach the hwip API (ERR_INVALID_URL).', 'NETWORK_ERROR', 0, { unsent: true, causeCode: 'ERR_INVALID_URL' });
        const parsed = parseFirstText(formatToolError(err));
        expect(parsed.suggestion).toMatch(/do not retry/i);
        expect(parsed.suggestion).toMatch(/HWIP_BASE_URL/);
    });

    // M41: the same transport code from the server's own upload address must not point at the configuration.
    it('does not point at HWIP_BASE_URL for an upload address the API itself gave', () => {
        const err = new ApiError('The hwip API gave an upload address that is not a usable URL, so the file was not uploaded', 'INVALID_UPLOAD_URL', 0, { unsent: true, causeCode: 'ERR_INVALID_URL' });
        const parsed = parseFirstText(formatToolError(err));
        expect(parsed.error).toBe('INVALID_UPLOAD_URL');
        expect(parsed.suggestion).toMatch(/do not correct HWIP_BASE_URL/i);
    });
});
