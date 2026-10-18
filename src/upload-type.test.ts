/**
 * The upload address is signed for one Content-Type header, and S3 answers 403 to a PUT that carries any
 * other: the server signs `fileType`, with `; charset=utf-8` added to `text/*` that has none (hwip server
 * `uploadContentType`, lib/s3.ts). The header used to depend on the shape of the body instead — a string
 * got a charset whatever its type, a Buffer got none — which only worked while the server signed nothing.
 * Types a browser runs (HTML, XHTML, SVG, XML) are refused by the server; files named like them are sent as text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HwipApiClient } from './api-client.js';
import { EXT_TO_MIME, inferMimeType, uploadContentType } from './mime.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

// The same table as hwip server src/__tests__/files-upload-content-type.test.ts: keep the two in step.
const SIGNED: ReadonlyArray<readonly [string, string]> = [
    ['image/png', 'image/png'],
    ['application/octet-stream', 'application/octet-stream'],
    ['application/json', 'application/json'],
    ['text/plain', 'text/plain; charset=utf-8'],
    ['text/markdown', 'text/markdown; charset=utf-8'],
    ['text/plain; charset=utf-16', 'text/plain; charset=utf-16'],
    // The server's check for an existing charset is case sensitive, and so is this one.
    ['text/plain; Charset=UTF-8', 'text/plain; Charset=UTF-8; charset=utf-8'],
];

describe('uploadContentType', () => {
    it.each(SIGNED)('writes %j as %j', (type, header) => {
        expect(uploadContentType(type)).toBe(header);
    });
});

describe('uploadToS3 sends the header the address was signed for', () => {
    const putHeader = async (content: string | Buffer, type: string): Promise<string | null> => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const client = new HwipApiClient({ apiKey: 'ak_x', baseUrl: 'https://api.example/v1' } as never);
        await client.uploadToS3('https://s3/up', content, type);
        const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
        return new Headers(init.headers).get('content-type');
    };

    it.each(SIGNED)('for %j, whether the body is a string or a Buffer', async (type, header) => {
        expect(await putHeader('hello', type)).toBe(header);
        expect(await putHeader(Buffer.from('hello'), type)).toBe(header);
    });
});

describe('a file named like a page the browser would run', () => {
    it.each(['page.html', 'PAGE.HTM', 'doc.xhtml', 'feed.xml', 'logo.svg', 'x.xsl'])('is sent as plain text: %s', (name) => {
        expect(inferMimeType(name)).toBe('text/plain');
    });

    // The server's lib/content-type.ts ACTIVE_TYPES: a type here would be refused with a 400.
    const ACTIVE = ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml'];

    it('is never in the map: no extension is typed as one the server refuses', () => {
        expect(Object.values(EXT_TO_MIME).filter((type) => ACTIVE.includes(type.split(';')[0]!.trim().toLowerCase()))).toEqual([]);
    });

    it('keeps the types it always had for the rest', () => {
        expect(inferMimeType('a.json')).toBe('application/json');
        expect(inferMimeType('a.md')).toBe('text/markdown');
        expect(inferMimeType('a.png')).toBe('image/png');
        expect(inferMimeType('a.pdf')).toBe('application/pdf');
        expect(inferMimeType('a.csv')).toBe('text/csv');
    });
});
