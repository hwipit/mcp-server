import { describe, expect, it, vi } from 'vitest';
import {
  ASK_ATTACH_RESERVE_MS,
  ASK_ATTACHMENT_BYTES,
  attachAskContext,
  attachWithinWindow,
  collectAskContext,
  liveAttach,
  padAskOriginal,
  readShownContext,
  type AskContextOriginal,
} from './ask-context-attach.js';

vi.mock('./crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crypto.js')>();
  return {
    ...actual,
    encryptFileForDevices: vi.fn(async (content: Buffer) => ({ ciphertext: Buffer.concat([content, Buffer.alloc(16)]), iv: 'IV', deviceKeyMap: { dev_phone: 'wrapped' } })),
  };
});

const CONTEXT: AskContextOriginal = {
  summary: {
    diff: 'ok', files: 1, added: 2, removed: 1,
    listed: [{ path: 'src/a.ts', status: 'M', added: 2, removed: 1 }],
    moreFiles: 0, screenLines: 1, masked: 0, cut: { diff: false, screen: false },
  },
  original: { diff: 'diff --git a/src/a.ts b/src/a.ts\n+한글\n', screen: '$ npm test' },
};
const RECIPIENTS = [{ deviceId: 'dev_phone', publicKey: 'PHONE' }];
const encrypt = async (content: string | Buffer) => ({ ciphertext: Buffer.concat([content as Buffer, Buffer.alloc(16)]), iv: 'IV', deviceKeyMap: { dev_phone: 'wrapped' } });
const WIRE = { fileKey: 'files/1', fileName: 'file', fileType: 'application/octet-stream', fileSize: 65536, iv: 'IV', deviceKeyMap: { dev_phone: 'wrapped' } };

describe('padAskOriginal', () => {
  it('holds the original as JSON at the start of exactly 64 KiB, and says how long it is', () => {
    const padded = padAskOriginal(CONTEXT);
    const text = JSON.stringify(CONTEXT.original);

    expect(ASK_ATTACHMENT_BYTES).toBe(65536);
    expect(padded.bytes.length).toBe(65536);
    expect(padded.size).toBe(Buffer.byteLength(text));
    expect(padded.bytes.subarray(0, padded.size).toString('utf-8')).toBe(text);
    expect(padded.bytes.subarray(padded.size).every((b) => b === 0)).toBe(true);
    expect(padded.context).toEqual(CONTEXT.summary);
  });

  it('is the same 64 KiB with nothing in it when there is no context, or one that does not fit', () => {
    for (const ctx of [null, { ...CONTEXT, original: { diff: 'x'.repeat(65536), screen: '' } }]) {
      const padded = padAskOriginal(ctx);
      expect(padded.bytes.length).toBe(65536);
      expect(padded.bytes.every((b) => b === 0)).toBe(true);
      expect(padded.size).toBe(0);
      expect(padded.context).toBeUndefined();
    }
  });
});

describe('readShownContext', () => {
  it('reads what `hwip ask-context show` prints', () => {
    expect(readShownContext(`${JSON.stringify({ context: CONTEXT })}\n`)).toEqual(CONTEXT);
  });

  it.each([
    ['no context', '{"context":null}'],
    ['the switch off', '{"context":null,"off":"project"}'],
    ['not JSON (an older CLI printing its status line)', 'ask context: on'],
    ['JSON null', 'null'],
    ['a summary the reader drops', JSON.stringify({ context: { ...CONTEXT, summary: { ...CONTEXT.summary, listed: [{ path: 'x'.repeat(129), status: 'M', added: 0, removed: 0 }] } } })],
    ['no summary', JSON.stringify({ context: { original: CONTEXT.original } })],
    ['an original that is not two strings', JSON.stringify({ context: { ...CONTEXT, original: { diff: 1, screen: '' } } })],
  ])('is null for %s', (_name, stdout) => {
    expect(readShownContext(stdout)).toBeNull();
  });
});

describe('attachAskContext', () => {
  it('shows the server the same name, type and size whatever the context is, and names the original only inside the seal', async () => {
    const withContext = await attachAskContext(RECIPIENTS, { context: async () => CONTEXT, encrypt, upload: async () => 'files/1' });
    const without = await attachAskContext(RECIPIENTS, { context: async () => { throw new Error('no hwip'); }, encrypt, upload: async () => 'files/1' });

    expect(withContext.file).toEqual(WIRE);
    expect(without.file).toEqual(WIRE);
    expect(withContext.context).toEqual(CONTEXT.summary);
    expect(withContext.meta).toEqual({ iv: 'IV', name: 'ask-context.json', type: 'application/vnd.hwip.ask-context+json', size: Buffer.byteLength(JSON.stringify(CONTEXT.original)) });
    expect(without.context).toBeUndefined();
    expect(without.meta.size).toBe(0);
  });
});

describe('attachWithinWindow', () => {
  it('keeps the last ten seconds of the window for the question: with no more than that left, nothing is read or stored', async () => {
    const upload = vi.fn(async () => 'files/1');
    const context = vi.fn(async () => null);

    expect(ASK_ATTACH_RESERVE_MS).toBe(10_000);
    await expect(attachWithinWindow(RECIPIENTS, { context, encrypt, upload }, 10_000)).rejects.toThrow();
    expect(context).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('gives up on an attachment that is not stored before the question would have to wait for it', async () => {
    vi.useFakeTimers();
    try {
      const attached = attachWithinWindow(RECIPIENTS, { context: async () => null, encrypt, upload: () => new Promise<string>(() => undefined) }, 15_000);
      const settled = expect(attached).rejects.toThrow('5000 ms');
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('collectAskContext', () => {
  it('asks the CLI with nothing but the subcommand', async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify({ context: CONTEXT }), stderr: '' }));
    const signal = new AbortController().signal;
    expect(await collectAskContext(exec, 60_000, signal)).toEqual(CONTEXT);
    expect(exec).toHaveBeenCalledWith(['ask-context', 'show'], signal);
  });

  it('does not ask with less than 20 seconds of the window left', async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify({ context: CONTEXT }), stderr: '' }));
    expect(await collectAskContext(exec, 19_999)).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('liveAttach', () => {
  const client = () => ({
    requestUpload: vi.fn(async () => ({ data: { fileId: 'f', fileKey: 'files/1', uploadUrl: 'https://s3.example/put' } })),
    uploadToS3: vi.fn(async () => undefined),
  });

  it('stores the sealed 64 KiB under the fixed name and type, under a signal the call\'s cancel stops', async () => {
    const api = client();
    const call = new AbortController();
    const signals: AbortSignal[] = [];
    const exec = vi.fn(async (_args: string[], s?: AbortSignal) => { signals.push(s!); return { stdout: JSON.stringify({ context: CONTEXT }), stderr: '' }; });

    const attached = await liveAttach(api, 60_000, call.signal, exec, () => undefined)(RECIPIENTS);

    expect(attached.file).toEqual(WIRE);
    expect(attached.context).toEqual(CONTEXT.summary);
    expect(exec).toHaveBeenCalledWith(['ask-context', 'show'], expect.any(AbortSignal));
    const [request, requestSignal] = api.requestUpload.mock.calls[0] as unknown as [unknown, AbortSignal];
    expect(request).toEqual({ fileName: 'file', fileType: 'application/octet-stream', fileSize: 65536 + 16 });
    const [url, bytes, type, putSignal] = api.uploadToS3.mock.calls[0] as unknown as [string, Buffer, string, AbortSignal];
    expect([url, bytes.length, type]).toEqual(['https://s3.example/put', 65552, 'application/octet-stream']);
    expect(new Set([signals[0], requestSignal, putSignal]).size).toBe(1);
    // Done: whatever still ran under it is stopped.
    expect(putSignal.aborted).toBe(true);
  });

  it('stops the CLI when the call is cancelled, and does not warn about it', async () => {
    const call = new AbortController();
    const warn = vi.fn();
    const exec = vi.fn((_args: string[], s?: AbortSignal) => new Promise<{ stdout: string; stderr: string }>((_, reject) => {
      s!.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    }));

    const attached = liveAttach(client(), 60_000, call.signal, exec, warn)(RECIPIENTS);
    call.abort();

    expect((await attached).meta.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('asks without a word when no `hwip` is installed', async () => {
    const warn = vi.fn();
    const exec = vi.fn(async () => { throw Object.assign(new Error('spawn hwip ENOENT'), { code: 'ENOENT' }); });
    expect((await liveAttach(client(), 60_000, undefined, exec, warn)(RECIPIENTS)).meta.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('says on stderr why the context is missing, and still attaches the empty original', async () => {
    const warn = vi.fn();
    const exec = vi.fn(async () => { throw Object.assign(new Error('hwip exited 2'), { code: 2 }); });

    const attached = await liveAttach(client(), 60_000, undefined, exec, warn)(RECIPIENTS);

    expect(attached.meta.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hwip exited 2'));
  });

  it('says on stderr why nothing was attached, but not for a window that was only short', async () => {
    const warn = vi.fn();
    const failing = { ...client(), requestUpload: vi.fn(async () => { throw new Error('upload-request 503'); }) };
    await expect(liveAttach(failing, 60_000, undefined, async () => ({ stdout: '{"context":null}', stderr: '' }), warn)(RECIPIENTS)).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('upload-request 503'));

    warn.mockClear();
    await expect(liveAttach(client(), 10_000, undefined, undefined, warn)(RECIPIENTS)).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
