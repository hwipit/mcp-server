import { vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

// Shared test scaffolding for the MCP tool/resource handlers. The register*
// functions take the api-client via DI and wire their handler into the server
// through server.registerTool / server.registerResource. These helpers stand
// in a fake server that captures the handler so a test can invoke it directly
// with already-validated args (Zod runs at the SDK boundary, not here).
//
// Excluded from the build via tsconfig `exclude` (it lives next to source but
// is test-only), so it never emits to dist.

/** Signature of a captured MCP tool handler. */
export type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<CallToolResult>;

/** Signature of a captured MCP resource read handler. */
export type ResourceHandler = (uri: URL) => Promise<ReadResourceResult>;

/**
 * Capture the handler a register*Tool function passes to registerTool. `run`
 * invokes it with a default ctx (a fresh sendNotification mock) so tools that
 * thread ctx into pollForResponse get a non-null value; tools that ignore ctx
 * are unaffected.
 */
export const captureTool = () => {
    let handler: Handler | undefined;
    const server = {
        registerTool: (_name: string, _config: unknown, h: Handler) => {
            handler = h;
        },
    } as unknown as McpServer;
    const run = (args: Record<string, unknown>, ctx: unknown = { sendNotification: vi.fn() }) => {
        if (!handler) throw new Error('tool was not registered');
        return handler(args, ctx);
    };
    return { server, run };
};

/** Capture the handler a register*Resource function passes to registerResource. */
export const captureResource = () => {
    let handler: ResourceHandler | undefined;
    const server = {
        registerResource: (_name: string, _uri: string, _meta: unknown, h: ResourceHandler) => {
            handler = h;
        },
    } as unknown as McpServer;
    const run = (uri: URL) => {
        if (!handler) throw new Error('resource was not registered');
        return handler(uri);
    };
    return { server, run };
};
