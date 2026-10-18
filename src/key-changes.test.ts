import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { textResult } from './error-format.js';
import {
    describeKeyChange, holdKeyChanges, keyChangesPath, MAX_KEY_CHANGES, noteOnce, recordKeyChanges, takeKeyChanges, withKeyChangeNote,
} from './key-changes.js';

let dir: string;
let trustPath: string;

const AT = '2026-10-13T09:00:00.000Z';
const stored = (): unknown => JSON.parse(readFileSync(keyChangesPath(trustPath), 'utf-8'));

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'key-changes-'));
    trustPath = join(dir, 'trusted-devices.json');
});

afterEach(() => {
    takeKeyChanges(trustPath);
    rmSync(dir, { recursive: true, force: true });
});

describe('key-changes.json', () => {
    it('lives beside the trust file', () => {
        expect(keyChangesPath(trustPath)).toBe(join(dir, 'key-changes.json'));
    });

    // The contract the cli writes and reads too, and the plugin reads (cli src/key-changes.test.ts pins the same line).
    it('writes the contract line, private', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }]);

        expect(readFileSync(keyChangesPath(trustPath), 'utf-8')).toBe('{"v":1,"changes":[{"deviceId":"dev_ios_1","at":"2026-10-13T09:00:00.000Z","name":"iPhone"}]}\n');
        expect(statSync(keyChangesPath(trustPath)).mode & 0o777).toBe(0o600);
    });

    it('keeps one line per device, updated in place', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }, { deviceId: 'dev_android_1', at: AT }]);
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: '2026-10-13T10:00:00.000Z', name: 'iPhone' }]);

        expect(stored()).toEqual({ v: 1, changes: [
            { deviceId: 'dev_ios_1', at: '2026-10-13T10:00:00.000Z', name: 'iPhone' },
            { deviceId: 'dev_android_1', at: AT },
        ] });
    });

    it('keeps the newest 64, dropping the oldest', () => {
        recordKeyChanges(trustPath, Array.from({ length: MAX_KEY_CHANGES + 2 }, (_, i) => ({ deviceId: `dev_${i}`, at: AT })));

        const changes = (stored() as { changes: { deviceId: string }[] }).changes;
        expect(changes).toHaveLength(MAX_KEY_CHANGES);
        expect(changes[0].deviceId).toBe('dev_2');
    });

    it('starts over from a record it cannot read', () => {
        writeFileSync(keyChangesPath(trustPath), '{ not json');

        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }]);

        expect(stored()).toEqual({ v: 1, changes: [{ deviceId: 'dev_ios_1', at: AT }] });
    });

    it('stores a name without control characters, cut short', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT, name: `\u001b[2Jphone\u202e ${'x'.repeat(200)}` }]);

        const name = (stored() as { changes: { name: string }[] }).changes[0].name;
        expect(name).not.toMatch(/[\u0000-\u001f\u202e]/u);
        expect(Array.from(name).length).toBeLessThanOrEqual(80);
        expect(name.startsWith('[2Jphone x')).toBe(true);
    });

    it('says whether the record was written', () => {
        const blocked = join(dir, 'file-not-folder');
        writeFileSync(blocked, '');

        expect(recordKeyChanges(join(blocked, 'trusted-devices.json'), [{ deviceId: 'dev_ios_1', at: AT }])).toBe(false);
        expect(recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }])).toBe(true);
    });

    it('throws nothing when the folder cannot hold the record', () => {
        const blocked = join(dir, 'file-not-folder');
        writeFileSync(blocked, '');
        expect(() => recordKeyChanges(join(blocked, 'trusted-devices.json'), [{ deviceId: 'dev_ios_1', at: AT }])).not.toThrow();
    });
});

describe('takeKeyChanges', () => {
    it('returns the changes once and removes the record', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }]);

        expect(takeKeyChanges(trustPath)).toEqual([{ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }]);
        expect(takeKeyChanges(trustPath)).toEqual([]);
        expect(readdirSync(dir)).toEqual([]);
    });

    // A writer holds the lock from reading the record to renaming its new one over it: what is taken then would come back.
    it('takes nothing from the record while a writer holds the lock, and leaves it', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }]);
        holdKeyChanges([{ deviceId: 'dev_android_1', at: AT }]);
        writeFileSync(join(dir, 'trusted-devices.lock'), `${process.pid} ${Date.now()}`);

        expect(takeKeyChanges(trustPath, { waitMs: 50 })).toEqual([{ deviceId: 'dev_android_1', at: AT }]);
        expect(existsSync(keyChangesPath(trustPath))).toBe(true);

        rmSync(join(dir, 'trusted-devices.lock'));
        expect(takeKeyChanges(trustPath)).toEqual([{ deviceId: 'dev_ios_1', at: AT }]);
        expect(existsSync(join(dir, 'trusted-devices.lock'))).toBe(false);
    });

    it('takes no lock, and makes no folder, when there is no record', () => {
        expect(takeKeyChanges(join(dir, 'never-made', 'trusted-devices.json'))).toEqual([]);
        expect(existsSync(join(dir, 'never-made'))).toBe(false);
    });

    it('gives a change to one of two takers only', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT }]);

        expect([takeKeyChanges(trustPath), takeKeyChanges(trustPath)].flat()).toHaveLength(1);
    });

    it('reads an unknown version or a broken record as none, and removes it', () => {
        writeFileSync(keyChangesPath(trustPath), '{"v":2,"changes":[{"deviceId":"dev_ios_1","at":"2026-10-13T09:00:00.000Z"}]}');
        expect(takeKeyChanges(trustPath)).toEqual([]);
        expect(existsSync(keyChangesPath(trustPath))).toBe(false);

        writeFileSync(keyChangesPath(trustPath), 'garbage');
        expect(takeKeyChanges(trustPath)).toEqual([]);
        expect(existsSync(keyChangesPath(trustPath))).toBe(false);
    });

    it('drops entries that are not a device id with an ISO time', () => {
        writeFileSync(keyChangesPath(trustPath), JSON.stringify({ v: 1, changes: [
            { deviceId: 'no spaces allowed', at: AT },
            { deviceId: 'dev_ios_1', at: '$(touch pwned)' },
            { deviceId: 'dev_ios_2', at: AT, name: 7 },
        ] }));

        expect(takeKeyChanges(trustPath)).toEqual([{ deviceId: 'dev_ios_2', at: AT }]);
    });

    // A pin this process could not write has no record: the change is held for the next result instead.
    it('also returns, once, the changes this process held for want of a record', () => {
        holdKeyChanges([{ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }]);
        recordKeyChanges(trustPath, [{ deviceId: 'dev_android_1', at: AT }]);

        expect(takeKeyChanges(trustPath).map((c) => c.deviceId).sort()).toEqual(['dev_android_1', 'dev_ios_1']);
        expect(takeKeyChanges(trustPath)).toEqual([]);
    });
});

describe('withKeyChangeNote', () => {
    it('ends a tool result with one Note line per change, once', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }]);

        const noted = withKeyChangeNote(textResult({ pushId: 'p1' }), trustPath);

        expect(noted.content).toEqual([
            { type: 'text', text: '{"pushId":"p1"}' },
            { type: 'text', text: 'Note: iPhone changed its encryption key — the new key is trusted. If you did not expect this, check it with: hwip trust' },
        ]);
        expect(withKeyChangeNote(textResult({ pushId: 'p2' }), trustPath).content).toHaveLength(1);
    });

    it('leaves an error a result with no change as it was', () => {
        const result = { content: [{ type: 'text' as const, text: '{}' }], isError: true };

        expect(withKeyChangeNote(result, trustPath)).toBe(result);
    });

    // A failure that comes back on every send is said by the first result only.
    it('ends a result with a held line once per process, after the key changes', () => {
        recordKeyChanges(trustPath, [{ deviceId: 'dev_ios_1', at: AT, name: 'iPhone' }]);
        noteOnce('could not register this machine\'s key (the server answered HTTP 404) — the app cannot verify who sent this push');

        expect(withKeyChangeNote(textResult({ pushId: 'p1' }), trustPath).content.slice(1)).toEqual([
            { type: 'text', text: 'Note: iPhone changed its encryption key — the new key is trusted. If you did not expect this, check it with: hwip trust' },
            { type: 'text', text: 'Note: could not register this machine\'s key (the server answered HTTP 404) — the app cannot verify who sent this push' },
        ]);

        noteOnce('could not register this machine\'s key (the server answered HTTP 404) — the app cannot verify who sent this push');
        expect(withKeyChangeNote(textResult({ pushId: 'p2' }), trustPath).content).toHaveLength(1);
    });

    it('names a device without a name by its id', () => {
        expect(describeKeyChange({ deviceId: 'dev_ios_1', at: AT })).toMatch(/^dev_ios_1 changed its encryption key/);
    });
});
