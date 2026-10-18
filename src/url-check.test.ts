import { describe, expect, it } from 'vitest';
import { downloadUrlProblem, insecureUrlWarning, wsUrlProblem } from './url-check.js';

describe('wsUrlProblem', () => {
    it.each([['wss://ws.hwip.app'], ['wss://ws-dev.hwip.app/'], ['ws://127.0.0.1:8080'], ['wss://h/stage?x=1']])('accepts %s', (url) => {
        expect(wsUrlProblem(url)).toBeNull();
    });

    it('asks a bare host for a scheme and shows the way to write it', () => {
        expect(wsUrlProblem('ws.hwip.app')).toBe('the WebSocket URL "ws.hwip.app" is not a URL — it needs a scheme, like wss://ws.hwip.app');
    });

    it.each([
        ['https://ws.hwip.app', /must start with ws:\/\/ or wss:\/\//],
        ['ftp://ws.hwip.app', /must start with ws:\/\/ or wss:\/\//],
        ['wss://', /not a URL/],
        ['', /not a URL/],
    ])('refuses %j', (url, why) => {
        expect(wsUrlProblem(url)).toMatch(why);
    });

    it('refuses what is not a string, a space and a fragment', () => {
        expect(wsUrlProblem(443)).toMatch(/has to be a string/);
        expect(wsUrlProblem(['wss://ws.hwip.app'])).toMatch(/has to be a string/);
        expect(wsUrlProblem(undefined)).toMatch(/has to be a string/);
        expect(wsUrlProblem('wss://ws.hwip.app ')).toMatch(/has a space/);
        expect(wsUrlProblem('wss://h/#x')).toMatch(/#fragment/);
    });

    it('never shows the userinfo, the query or the fragment of what it refuses', () => {
        const problem = wsUrlProblem('https://user:hunter2@ws.hwip.app/p?apiKey=ak_SECRET#frag') ?? '';

        expect(problem).toContain('https://ws.hwip.app/p');
        expect(problem).not.toMatch(/hunter2|ak_SECRET|frag|user:/);
    });
});

describe('insecureUrlWarning', () => {
    it.each([
        ['https://api.hwip.app'],
        ['wss://ws.hwip.app'],
        ['http://localhost:3000'],
        ['ws://127.0.0.1:8080'],
        ['http://[::1]:3000'],
        ['http://localhost.:3000'],
        ['ws://0.0.0.0:1'],
        ['not a url'],
    ])('stays quiet for %s', (url) => {
        expect(insecureUrlWarning(url)).toBeNull();
    });

    it('warns for a plain http base URL off this machine, naming the host and not the path or userinfo', () => {
        const w = insecureUrlWarning('http://user:pw@api.example.com:8080/secret/path') ?? '';
        expect(w).toContain('api.example.com:8080');
        expect(w).toContain('http://');
        expect(w).not.toMatch(/pw|secret/);
    });

    it('warns for a plain ws socket off this machine', () => {
        expect(insecureUrlWarning('ws://ws.example.com')).toMatch(/ws\.example\.com.*plain ws:\/\//);
    });
});

describe('downloadUrlProblem — answer files', () => {
    it.each([
        ['https://hwip-files.s3.ap-northeast-2.amazonaws.com/u/f?X-Amz-Signature=s', 'https://api.hwip.app'],
        ['http://localhost:4566/bucket/u/f', 'http://localhost:3000'],
    ])('takes %s', (url, api) => {
        expect(downloadUrlProblem(url, api)).toBeNull();
    });

    it.each([
        ['https://evil.example.com/f', 'https://api.hwip.app'],
        ['http://192.168.0.10/admin', 'http://192.168.0.2:3000'],
        ['http://169.254.169.254/latest/meta-data', 'http://localhost:3000'],
        ['http://localhost:4566/f', 'https://api.hwip.app'],
        ['https://s3.amazonaws.com.evil.example/f', 'https://api.hwip.app'],
    ])('refuses %s', (url, api) => {
        expect(downloadUrlProblem(url, api)).toMatch(/not an S3 download address/);
    });
});
