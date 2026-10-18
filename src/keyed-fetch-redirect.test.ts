/**
 * A call that carries the API key must not follow a redirect: undici drops
 * `authorization` and `cookie` across origins but not `X-API-Key`, so the key
 * reached whatever host an answer's Location named. Two real servers on
 * 127.0.0.1: `front` answers every request with a 307 to `target`, which records
 * the headers it gets. Nothing leaves the machine.
 */
import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, HwipApiClient } from './api-client.js';
import { formatToolError } from './error-format.js';
import type { McpServerConfig } from './config.js';

const KEY = 'ak_SECRET_KEY_FOR_REDIRECT_TEST';

const listen = (handler: http.RequestListener): Promise<{ server: http.Server; url: string }> =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });

let front: { server: http.Server; url: string };
let target: { server: http.Server; url: string };
let seen: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
  target = await listen((req, res) => {
    seen.push(req.headers);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: {} }));
  });
  front = await listen((_req, res) => {
    res.statusCode = 307;
    res.setHeader('Location', `${target.url}/elsewhere`);
    res.end();
  });
});
afterAll(() => {
  front.server.close();
  target.server.close();
});

beforeEach(() => {
  seen = [];
});

describe('a keyed call does not follow a redirect', () => {
  it('the API client (every tool)', async () => {
    const client = new HwipApiClient({ apiKey: KEY, baseUrl: front.url } as McpServerConfig);

    const err = await client.listPushes().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'REDIRECT_REFUSED', status: 0 });
    expect(seen).toEqual([]);
    expect((err as Error).message).not.toContain(KEY);
  });

  it('registering this machine\'s key', async () => {
    const client = new HwipApiClient({ apiKey: KEY, baseUrl: front.url } as McpServerConfig);

    const err = await client.registerDeviceKey('dev_listener_0a1b2c3d', 'pub', 'desk').catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'REDIRECT_REFUSED', status: 0 });
    expect(seen).toEqual([]);
  });

  it('a write too, and it does not claim the write may have landed', async () => {
    const client = new HwipApiClient({ apiKey: KEY, baseUrl: front.url } as McpServerConfig);

    const err = await client.dismissAllPushes().catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'REDIRECT_REFUSED' });
    expect((err as Error).message).not.toContain('may still have reached');
    expect(seen).toEqual([]);
  });

  it('tells the agent not to retry, and what to correct', async () => {
    const client = new HwipApiClient({ apiKey: KEY, baseUrl: front.url } as McpServerConfig);
    const err = await client.listPushes().catch((e: unknown) => e);

    const result = formatToolError(err);

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text) as { error: string; suggestion: string };
    expect(body.error).toBe('REDIRECT_REFUSED');
    expect(body.suggestion).toMatch(/Do not retry.*HWIP_BASE_URL/);
  });
});

// A new call that carries the key has to say how it treats a redirect.
describe('every file that sends X-API-Key', () => {
  const dir = __dirname;
  // Every source file under src/, tools/ and resources/ included.
  const sources = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  // Code only: a comment that names the header is not a request.
  const codeOf = (file: string): string =>
    readFileSync(join(dir, file), 'utf-8').replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('refuses to follow a redirect, once per place that sets the header', () => {
    const senders = sources.filter((f) => /x-api-key/i.test(codeOf(f)));

    expect(senders.length).toBeGreaterThan(0);
    for (const file of senders) {
      const code = codeOf(file);
      const sets = (code.match(/x-api-key/gi) ?? []).length;
      const refusals = (code.match(/redirect:\s*'error'/g) ?? []).length;
      expect(refusals, `${file}: ${sets} place(s) set X-API-Key, ${refusals} refuse redirects`).toBeGreaterThanOrEqual(sets);
    }
  });
});
