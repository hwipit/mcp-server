import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';

// pollForResponse owns the long-poll loop (covered in poll.test.ts). Here we
// mock it so the hwip_ask handler's branching — trigger → poll → shape result
// — is tested in isolation without timers or network.
vi.mock('../poll.js', async () => {
    const actual = await vi.importActual<typeof import('../poll.js')>('../poll.js');
    return { ...actual, pollForResponse: vi.fn() };
});

// Mock crypto: this machine has its keys unless a test takes them away (see notify.test.ts).
vi.mock('../crypto.js', () => ({
    cryptoReady: vi.fn(async () => undefined),
    getKeyPair: vi.fn(() => null),
    getPublicKey: vi.fn(() => null),
    selectRecipients: vi.fn(() => RECIPIENTS),
    encryptPushBodyForDevices: vi.fn(),
    encryptFileForDevices: vi.fn(),
}));

// The seal reads and pins in the trust file; keep the developer's own out of the tests.
vi.mock('../trust-pins.js', async () => {
    const actual = await vi.importActual<typeof import('../trust-pins.js')>('../trust-pins.js');
    return { ...actual, TRUST_PATH: '/nonexistent/hwip-test/trusted-devices.json' };
});

// The seal itself is ask-seal.test.ts; here only what the tool does with its verdicts.
// Each test starts with a question that seals and an answer that opens as the test's
// `response` reads (scripted in beforeEach); `realSeal()` puts the real ones back.
const sealMock = vi.hoisted(() => ({ prepareAsk: vi.fn(), openAnswer: vi.fn() }));
vi.mock('../ask-seal.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../ask-seal.js')>();
    return { ...actual, prepareAsk: sealMock.prepareAsk, openAnswer: sealMock.openAnswer };
});
const realSeal = async () => {
    const actual = await vi.importActual<typeof import('../ask-seal.js')>('../ask-seal.js');
    sealMock.prepareAsk.mockImplementation(actual.prepareAsk);
    sealMock.openAnswer.mockImplementation(actual.openAnswer);
};
const FIELDS = { body: '{"ciphertext":"c","iv":"i"}', senderPublicKey: 'SENDER', deviceKeyMap: { dev_phone: 'k' } };
/** An answer as the phone meant it, as the opened seal reports it. */
const openedAs = (response: { actionId?: string; value?: string; exitRemote?: boolean } | undefined) => ({
    ok: true,
    ...(response?.actionId ? { actionId: response.actionId } : {}),
    ...(response?.value ? { value: response.value } : {}),
    ...(response?.exitRemote ? { exit: true } : {}),
});

// Saving the files is answer-files.test.ts; here only what the tool hands it and returns.
const filesMock = vi.hoisted(() => ({ saveAnswerFiles: vi.fn() }));
vi.mock('../answer-files.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../answer-files.js')>()),
    saveAnswerFiles: filesMock.saveAnswerFiles,
}));

// The attachment itself is ask-context-attach.test.ts; here only what the tool hands it.
const attachMock = vi.hoisted(() => ({ liveAttach: vi.fn(() => async () => { throw new Error('not in these tests'); }) }));
vi.mock('../ask-context-attach.js', () => attachMock);

import { AskError, pollForResponse } from '../poll.js';
import { registerAskTool, sealDepsFor } from './ask.js';
import { TRUST_PATH } from '../trust-pins.js';
import { listenerDeviceId } from '../config.js';
import { ApiError, type HwipApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import type { HookEventResponse } from '../types.js';
import { getKeyPair, getPublicKey } from '../crypto.js';
import { holdKeyChanges } from '../key-changes.js';

const RECIPIENTS = [{ deviceId: 'dev_phone', publicKey: 'phone-pub' }];

const mkConfig = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    sessionId: 'sess_1',
    hookId: 'hook_1',
    ...over,
});

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

// A stub carries only the methods its test drives; Partial is what `satisfies`
// already checked it against, so one assertion widens it to the full client.
const stubClient = (client: Partial<HwipApiClient>): HwipApiClient => client as HwipApiClient; // stub: the handler calls only what the test defined

const polled = vi.mocked(pollForResponse);

const event = (data: HookEventResponse['data']): HookEventResponse => ({ data });

// An answered ask now writes the sticky-REMOTE state file (remote-state.ts),
// so every test in here has to be pointed at a throwaway state dir — without
// this the suite writes into the developer's real ~/.local/state/hwip, keyed
// by whatever directory the test runner happens to sit in.
let STATE_TMP: string;
let savedStateHome: string | undefined;
let savedProjectDir: string | undefined;

const remoteStateFile = (): string =>
    join(STATE_TMP, 'state', 'hwip',
        `remote-active-${execFileSync('cksum', { input: STATE_TMP, encoding: 'utf-8' }).split(' ')[0]}`);

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
    vi.mocked(getPublicKey).mockReturnValue('PUB');
    sealMock.prepareAsk.mockReset().mockImplementation(async (question: { actions?: { id: string }[] }) =>
        ({ kind: 'sealed', askId: 'ASK', fields: FIELDS, offered: question.actions?.map((a) => a.id) }));
    sealMock.openAnswer.mockReset().mockImplementation(async (response: Parameters<typeof openedAs>[0]) => openedAs(response));

    STATE_TMP = mkdtempSync(join(tmpdir(), 'hwip-ask-test-'));
    savedStateHome = process.env.XDG_STATE_HOME;
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.XDG_STATE_HOME = join(STATE_TMP, 'state');
    process.env.CLAUDE_PROJECT_DIR = STATE_TMP;
    // The dir exists up front so a test can seed an already-REMOTE session;
    // the production writer creates it itself.
    mkdirSync(join(STATE_TMP, 'state', 'hwip'), { recursive: true });
});

afterEach(() => {
    if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedStateHome;
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    rmSync(STATE_TMP, { recursive: true, force: true });
});

describe('registerAskTool', () => {
    it('returns HOOK_NOT_CONFIGURED when no hookId is configured', async () => {
        const client = { triggerHook: vi.fn() } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig({ hookId: undefined }));

        const result = await run({ title: 'T', timeout: 120, inputType: 'text' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('HOOK_NOT_CONFIGURED');
        expect(client.triggerHook).not.toHaveBeenCalled();
    });

    // Said even when the ask itself went nowhere: the agent reads this result and no other.
    it('ends a refused result with a Note for a device whose key changed', async () => {
        holdKeyChanges([{ deviceId: 'dev_phone', at: '2026-10-13T09:00:00.000Z', name: 'iPhone' }]);
        const { server, run } = captureTool();
        registerAskTool(server, stubClient({}), mkConfig({ hookId: undefined }));

        const result = await run({ title: 'T', timeout: 120, inputType: 'text' });

        expect(parse(result).error).toBe('HOOK_NOT_CONFIGURED');
        expect(result.content[1]).toEqual({ type: 'text', text: 'Note: iPhone changed its encryption key — the new key is trusted. If you did not expect this, check it with: hwip trust' });
    });

    it('triggers a combo hook, threads the eventId/timeout to the poll, and returns the actionId', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<HwipApiClient>;
        const apiClient = client as unknown as HwipApiClient;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { actionId: 'yes' } }));
        const { server, run } = captureTool();
        registerAskTool(server, apiClient, mkConfig());

        const actions = [
            { id: 'yes', label: 'Yes', style: 'primary' },
            { id: 'no', label: 'No', style: 'secondary' },
        ];
        const result = await run({ title: 'Deploy?', body: 'ship it', actions, inputType: 'text', timeout: 120 });

        expect(sealMock.prepareAsk).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'proj · Deploy?', body: 'ship it', actions }),
            expect.anything(),
        );
        expect(client.triggerHook).toHaveBeenCalledWith(
            'hook_1',
            expect.objectContaining({
                isEncrypted: true,
                ...FIELDS,
                actions: [{ id: 'yes', style: 'primary' }, { id: 'no', style: 'secondary' }],
                hookType: 'combo',
                timeout: 120,
                sessionId: 'sess_1',
            }),
            undefined,
            // The question's own window, for the send's retries.
            expect.objectContaining({ withinMs: 120_000 }),
        );
        // Trigger → poll threading: the eventId from the trigger response and
        // the requested timeout must flow into pollForResponse unchanged.
        expect(polled).toHaveBeenCalledWith(apiClient, 'hook_1', 'e1', 120, expect.anything(), undefined);
        expect(parse(result)).toEqual({ actionId: 'yes', timedOut: false, hwipState: 'REMOTE' });
    });

    it('returns the typed value when the user submits text', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { value: 'typed answer' } }));
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Name?', inputType: 'text', timeout: 120 });

        expect(parse(result)).toEqual({ value: 'typed answer', timedOut: false, hwipState: 'REMOTE' });
    });

    // The four outcomes that move (or deliberately don't move) sticky REMOTE.
    // Asserted on the file itself, not just on `hwipState`: the file is what
    // the prompt hooks read, and reporting one thing while writing another is
    // the failure this whole slice exists to prevent.

    it('a non-exit button enters REMOTE', async () => {
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { actionId: 'review' } }));
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Next?', inputType: 'text', timeout: 120 });

        expect(parse(result).hwipState).toBe('REMOTE');
        expect(existsSync(remoteStateFile())).toBe(true);
    });

    it('a Done-like button leaves REMOTE, whatever its casing', async () => {
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { actionId: 'Done' } }));
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        writeFileSync(remoteStateFile(), '1800000000\n');
        const result = await run({ title: 'Next?', inputType: 'text', timeout: 120 });

        expect(parse(result).hwipState).toBe('NORMAL');
        expect(existsSync(remoteStateFile())).toBe(false);
    });

    it('text sent with exitRemote leaves REMOTE and still reaches the model', async () => {
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(event({
            eventId: 'e1',
            status: 'responded',
            response: { value: 'run the tests', exitRemote: true },
        }));
        const { server, run } = captureTool();
        registerAskTool(server, stubClient(client), mkConfig());

        writeFileSync(remoteStateFile(), '1800000000\n');
        const result = await run({ title: 'Next?', inputType: 'text', timeout: 120 });

        expect(parse(result)).toEqual({ value: 'run the tests', timedOut: false, hwipState: 'NORMAL' });
        expect(existsSync(remoteStateFile())).toBe(false);
    });

    it('a button id outranks exitRemote on the same answer', async () => {
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(event({
            eventId: 'e1',
            status: 'responded',
            response: { actionId: 'review', exitRemote: true },
        }));
        const { server, run } = captureTool();
        registerAskTool(server, stubClient(client), mkConfig());

        const result = await run({ title: 'Next?', inputType: 'text', timeout: 120 });

        expect(parse(result)).toEqual({ actionId: 'review', timedOut: false, hwipState: 'REMOTE' });
        expect(existsSync(remoteStateFile())).toBe(true);
    });

    // The phone shows "send and exit" only on asks that carry this flag, so the
    // button never appears on an approval-gate ask (cli `hwip ask`, same hook
    // type) or on an ask from a server too old to settle the answer.
    it('tells the server this ask understands a send-and-exit answer', async () => {
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { actionId: 'yes' } }));
        const { server, run } = captureTool();
        registerAskTool(server, stubClient(client), mkConfig());

        await run({ title: 'Next?', inputType: 'text', timeout: 120 });

        expect(client.triggerHook).toHaveBeenCalledWith('hook_1', expect.objectContaining({ acceptsExit: true }), undefined, expect.anything());
    });

    it('a timeout onto a Done-like fallback leaves REMOTE', async () => {
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(null);
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        writeFileSync(remoteStateFile(), '1800000000\n');
        const result = await run({ title: 'Next?', actions: [{ id: 'done', label: 'done' }], inputType: 'text', timeout: 120, fallback: 'done' });

        expect(parse(result)).toMatchObject({ actionId: 'done', timedOut: true, hwipState: 'NORMAL' });
        expect(existsSync(remoteStateFile())).toBe(false);
    });

    // Rule 5 recommends `wait`/`review` as the safe fallback, and an unanswered
    // ask is not a user action in either direction: it must not end REMOTE, and
    // it must not start it. So the file is left exactly as found and the result
    // claims no state at all.
    it('a timeout onto a safe fallback moves nothing', async () => {
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(null);
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Next?', actions: [{ id: 'wait', label: 'wait' }], inputType: 'text', timeout: 120, fallback: 'wait' });

        expect(parse(result)).toEqual({ actionId: 'wait', timedOut: true });
        expect(existsSync(remoteStateFile())).toBe(false);
    });

    // Buttons that leaked in with a style no button has: dropping them would ask with none, and say nothing of it.
    it('refuses a call whose buttons were recovered from the body with a style that is none', async () => {
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, stubClient(client), mkConfig());

        const leakedBody = 'Wipe it?</body>\n<parameter name="actions">[{"id":"keep","label":"Keep"},{"id":"wipe","label":"Wipe","style":"explode"}]';
        const result = await run({ title: 'Q', body: leakedBody, inputType: 'text', timeout: 120 });

        expect(result.isError).toBe(true);
        expect(parse(result)).toMatchObject({ error: 'INVALID_INPUT', message: expect.stringContaining('style') });
        expect(client.triggerHook).not.toHaveBeenCalled();
    });

    // The danger check goes by `style`: one that leaked in under another case is still the button it guards.
    it('refuses a danger fallback whose button was recovered from the body with its style in another case', async () => {
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, stubClient(client), mkConfig());

        const leakedBody = 'Wipe it?</body>\n<parameter name="actions">[{"id":"keep","label":"Keep"},{"id":"wipe","label":"Wipe","style":"Danger"}]';
        const result = await run({ title: 'Q', body: leakedBody, inputType: 'text', timeout: 120, fallback: 'wipe' });

        expect(result.isError).toBe(true);
        expect(parse(result)).toMatchObject({ error: 'INVALID_FALLBACK', message: expect.stringContaining('is a danger action') });
        expect(client.triggerHook).not.toHaveBeenCalled();
    });

    it('recovers actions that leaked into the body of a malformed call', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { actionId: 'commit' } }));
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const leakedBody =
            'Commit now?</body>\n<parameter name="actions">[{"id":"commit","label":"Commit"},{"id":"test","label":"Test"}]';
        await run({ title: 'Q', body: leakedBody, inputType: 'text', timeout: 120 });

        expect(sealMock.prepareAsk).toHaveBeenCalledWith(
            expect.objectContaining({
                body: 'Commit now?',
                actions: [
                    { id: 'commit', label: 'Commit' },
                    { id: 'test', label: 'Test' },
                ],
            }),
            expect.anything(),
        );
        expect(client.triggerHook).toHaveBeenCalledWith('hook_1', expect.objectContaining({ actions: [{ id: 'commit' }, { id: 'test' }] }), undefined, expect.anything());
    });

    it('sends nothing when the call was cancelled before the trigger', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());
        const controller = new AbortController();
        controller.abort();

        const result = await run({ title: 'Q', inputType: 'text', timeout: 120 }, { sendNotification: vi.fn(), signal: controller.signal });

        expect(client.triggerHook).not.toHaveBeenCalled();
        expect(polled).not.toHaveBeenCalled();
        expect(parse(result).error).toBe('ABORTED');
    });

    it('hands the abort signal to the trigger request, and reports a cancel there as ABORTED', async () => {
        const controller = new AbortController();
        const client = {
            triggerHook: vi.fn(async () => {
                controller.abort();
                throw new DOMException('This operation was aborted', 'AbortError');
            }),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Q', inputType: 'text', timeout: 120 }, { sendNotification: vi.fn(), signal: controller.signal });

        expect((client.triggerHook.mock.calls[0] as unknown[])[2]).toBe(controller.signal);
        expect(parse(result)).toMatchObject({ error: 'ABORTED', message: expect.stringContaining('may still have reached the phone') });
    });

    it.each([
        ['a typo of an action id', [{ id: 'yes', label: 'Yes' }], 'yse', /neither an action id \(yes\) nor done\/stop\/exit/],
        ['a typo of a Done-like id', [{ id: 'yes', label: 'Yes' }], 'don', /neither an action id \(yes\) nor done\/stop\/exit/],
        ['anything else on a text-only ask', undefined, 'skip', /neither an action id nor done\/stop\/exit/],
    ])('refuses %s as a fallback, before anything is sent', async (_, actions, fallback, message) => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Q', actions, inputType: 'text', timeout: 120, fallback });

        expect(result.isError).toBe(true);
        expect(parse(result)).toMatchObject({
            error: 'INVALID_FALLBACK',
            message: expect.stringMatching(message),
            suggestion: expect.stringContaining('done/stop/exit'),
        });
        expect(client.triggerHook).not.toHaveBeenCalled();
    });

    // A fallback is the one answer nobody gave: silence does not get to pick the choice marked as the dangerous one.
    it.each([
        ['a danger button', [{ id: 'wipe', label: 'Wipe', style: 'danger' }, { id: 'keep', label: 'Keep' }], 'wipe'],
        ['a danger button whose id is a Done-like one', [{ id: 'stop', label: 'Stop the deploy', style: 'danger' }, { id: 'keep', label: 'Keep' }], 'stop'],
        // A Done-like id is read without its case or the space around it (remote-state.ts isSessionExitId), so the button is too.
        ['a danger button under another spelling of its Done-like id', [{ id: 'stop', label: 'Stop the deploy', style: 'danger' }, { id: 'keep', label: 'Keep' }], ' STOP'],
        ['a Done-like id that a danger button spells another way', [{ id: 'Stop', label: 'Stop the deploy', style: 'danger' }, { id: 'keep', label: 'Keep' }], 'stop'],
    ])('refuses %s as a fallback, before anything is sent', async (_, actions, fallback) => {
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, stubClient(client), mkConfig());

        const result = await run({ title: 'Q', actions, inputType: 'text', timeout: 120, fallback });

        expect(result.isError).toBe(true);
        expect(parse(result)).toMatchObject({
            error: 'INVALID_FALLBACK',
            message: expect.stringContaining(`fallback "${fallback}" is a danger action`),
            suggestion: expect.stringContaining('safe'),
        });
        expect(client.triggerHook).not.toHaveBeenCalled();
    });

    it('takes a safe button as the fallback of an ask that also offers a danger one', async () => {
        polled.mockResolvedValue(null);
        const client = { triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })) } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, stubClient(client), mkConfig());
        const actions = [{ id: 'wipe', label: 'Wipe', style: 'danger' }, { id: 'keep', label: 'Keep', style: 'secondary' }];

        expect(parse(await run({ title: 'Q', actions, inputType: 'text', timeout: 120, fallback: 'keep' }))).toMatchObject({ actionId: 'keep', timedOut: true });
        expect(client.triggerHook).toHaveBeenCalledTimes(1);
    });

    // The REMOTE contract (plugin CLAUDE.md, CORE_RULES): 2–4 actions plus a
    // Done-like fallback, so an unanswered ask ends the loop quietly — the
    // fallback need not be one of the buttons, and a text-only ask may use it.
    it.each([
        ['outside the actions', [{ id: 'fix', label: 'Fix' }, { id: 'skip', label: 'Skip' }], 'done'],
        ['in any case', [{ id: 'fix', label: 'Fix' }], 'Done'],
        ['on a text-only ask', undefined, 'exit'],
    ])('accepts a Done-like fallback %s, and ends REMOTE on timeout', async (_, actions, fallback) => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(null);
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Next?', actions, inputType: 'text', timeout: 120, fallback });

        expect(client.triggerHook).toHaveBeenCalledWith('hook_1', expect.objectContaining({ fallback }), undefined, expect.anything());
        expect(parse(result)).toMatchObject({ actionId: fallback, timedOut: true, hwipState: 'NORMAL' });
    });

    describe('a send that has to be repeated', () => {
        /** A trigger the client had to send `tries` more times before the server answered `data`. */
        const retriedTrigger = (tries: number, data: { notified?: boolean } = {}): Partial<HwipApiClient> => ({
            triggerHook: async (_hook, _params, _signal, retry) => {
                for (let n = 1; n <= tries; n++) await retry?.onRetry?.(n);
                return { data: { pushId: 'p', eventId: 'e1', ...data } };
            },
        });
        const UNCONFIRMED = 'The question went up on a retry, and the server did not say the phone was notified: it is in the app either way.';
        const ask = async (client: Partial<HwipApiClient>, ctx: object = { sendNotification: vi.fn() }) => {
            polled.mockResolvedValue(null);
            const { server, run } = captureTool();
            registerAskTool(server, stubClient(client), mkConfig());
            return parse(await run({ title: 'Q', actions: [{ id: 'wait', label: 'wait' }], inputType: 'text', timeout: 120, fallback: 'wait' }, ctx));
        };

        it('keeps the call alive with a rising progress notification for each repeat', async () => {
            const sendNotification = vi.fn(async () => undefined);
            await ask(retriedTrigger(3), { sendNotification, _meta: { progressToken: 'tok' } });
            const sentProgress = sendNotification.mock.calls.map(([n]: [{ method: string; params: { progressToken: string; progress: number } }]) => n);
            expect(sentProgress.map((n) => n.method)).toEqual(Array(3).fill('notifications/progress'));
            expect(sentProgress.every((n) => n.params.progressToken === 'tok')).toBe(true);
            const values = sentProgress.map((n) => n.params.progress);
            expect(values).toEqual([...values].sort((a, b) => a - b));
            expect(new Set(values).size).toBe(3);
            // The wait that follows starts its own count at 5 (poll.ts PROGRESS_INTERVAL_SECONDS), and progress may only rise.
            expect(Math.max(...values)).toBeLessThan(5);
        });

        it('sends no progress to a client that did not ask for it', async () => {
            const sendNotification = vi.fn(async () => undefined);
            await ask(retriedTrigger(2), { sendNotification });
            expect(sendNotification).not.toHaveBeenCalled();
        });

        // A repeat the server had already taken is answered with the question's ids alone (hwip server/src/functions/hooks.ts,
        // `once.replayed`, read 2026-10-14): the push went out with the first request or not at all.
        it('says nobody may have been pinged when the answer does not say the phone was notified, and the ask ends unanswered', async () => {
            expect(await ask(retriedTrigger(1))).toEqual({ actionId: 'wait', timedOut: true, notice: UNCONFIRMED });
            expect(await ask(retriedTrigger(1, { notified: false }))).toEqual({ actionId: 'wait', timedOut: true, notice: UNCONFIRMED });
        });

        it('says nothing when the answer says the phone was notified, or when the first try was taken', async () => {
            expect(await ask(retriedTrigger(1, { notified: true }))).toEqual({ actionId: 'wait', timedOut: true });
            expect(await ask(retriedTrigger(0))).toEqual({ actionId: 'wait', timedOut: true });
        });
    });

    it('returns the fallback action on timeout when one is supplied', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(null);
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Q', actions: [{ id: 'cancel', label: 'cancel' }], inputType: 'text', timeout: 120, fallback: 'cancel' });

        expect(parse(result)).toEqual({ actionId: 'cancel', timedOut: true });
    });

    it('returns timedOut, not an error, on timeout with no fallback', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(null);
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Q', inputType: 'text', timeout: 120 });

        // One shape with the fallback case — an error here read as "try again".
        expect(result.isError).toBeUndefined();
        const body = parse(result);
        expect(body.timedOut).toBe(true);
        expect(body.actionId).toBeUndefined();
        expect(body.message).toContain('120 seconds');
    });

    it('reports a cancel from the phone as CANCELLED, with the eventId and a do-not-repeat hint', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<HwipApiClient>;
        polled.mockRejectedValue(new AskError('CANCELLED', 'cancelled on phone', 'e1'));
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Q', inputType: 'text', timeout: 120 });

        expect(result.isError).toBe(true);
        const body = parse(result);
        expect(body.error).toBe('CANCELLED');
        expect(body.eventId).toBe('e1');
        expect(body.suggestion).toMatch(/do not ask it again/i);
    });

    it('hands the call\'s abort signal to the poll loop', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<HwipApiClient>;
        polled.mockResolvedValue(null);
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());
        const signal = new AbortController().signal;

        await run({ title: 'Q', inputType: 'text', timeout: 120 }, { sendNotification: vi.fn(), signal });

        expect(polled.mock.calls[0][4]).toEqual(expect.objectContaining({ signal }));
    });

    it('formats a triggerHook ApiError into a structured error result', async () => {
        const client = {
            triggerHook: vi.fn(async () => {
                throw new ApiError('disabled', 'HOOK_DISABLED', 400);
            }),
        } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Q', inputType: 'text', timeout: 120 });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('HOOK_DISABLED');
    });

    // M41: a seal lookup that failed on the configuration comes back as that error, not SEALED_ASK_FAILED.
    it('reports a configuration failure from the seal lookups as itself', async () => {
        sealMock.prepareAsk.mockRejectedValue(new ApiError('Could not reach the hwip API (ERR_INVALID_URL).', 'NETWORK_ERROR', 0, { unsent: true, causeCode: 'ERR_INVALID_URL' }));
        const client = { triggerHook: vi.fn() } satisfies Partial<HwipApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as HwipApiClient, mkConfig());

        const result = await run({ title: 'Q', inputType: 'text', timeout: 120 });

        expect(result.isError).toBe(true);
        expect(parse(result)).toMatchObject({ error: 'NETWORK_ERROR' });
        expect(parse(result).suggestion).toMatch(/HWIP_BASE_URL/);
        expect(client.triggerHook).not.toHaveBeenCalled();
    });

    describe('with a sealed question', () => {
        const SEALED_RESPONSE = { sealed: FIELDS, respondedDeviceId: 'dev_phone' };
        const ready = () => sealMock.prepareAsk.mockResolvedValue({ kind: 'sealed', askId: 'ASK', fields: FIELDS, offered: ['yes', 'no'] });
        const ACTIONS = [
            { id: 'yes', label: 'Yes', style: 'primary' },
            { id: 'no', label: 'No', style: 'secondary' },
        ];
        const setup = (over: Partial<HwipApiClient> = {}) => {
            const client = {
                triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
                requestUpload: vi.fn(),
                uploadToS3: vi.fn(),
                ...over,
            };
            const { server, run } = captureTool();
            registerAskTool(server, client as unknown as HwipApiClient, mkConfig());
            return { client, run };
        };

        afterEach(() => {
            vi.useRealTimers();
        });

        it('hands the question\'s context attachment on with the trigger, and gives the seal a way to make it', async () => {
            const file = { fileKey: 'files/1', fileName: 'file', fileType: 'application/octet-stream', fileSize: 65536, iv: 'IV', deviceKeyMap: { dev_phone: 'w' } };
            sealMock.prepareAsk.mockResolvedValue({ kind: 'sealed', askId: 'ASK', fields: FIELDS, offered: ['yes', 'no'], files: [file] });
            sealMock.openAnswer.mockResolvedValue({ ok: true, actionId: 'yes' });
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: SEALED_RESPONSE }));
            const { client, run } = setup();

            const signal = new AbortController().signal;
            await run({ title: 'Deploy?', actions: ACTIONS, timeout: 120 }, { sendNotification: vi.fn(), signal });

            const sent = (client.triggerHook.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
            expect(sent.files).toEqual([file]);
            const deps = sealMock.prepareAsk.mock.calls[0]![1] as { attach?: unknown };
            expect(typeof deps.attach).toBe('function');
            // The whole window the question is given, and the call's cancel.
            expect(attachMock.liveAttach).toHaveBeenCalledWith(client, 120_000, signal);
        });

        it('hands the server the envelope, each button\'s id and style, and the input type — nothing else', async () => {
            ready();
            sealMock.openAnswer.mockResolvedValue({ ok: true, actionId: 'yes' });
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: SEALED_RESPONSE }));
            const { client, run } = setup();

            const longBody = 'secret '.repeat(60);
            await run({ title: 'Deploy?', body: longBody, actions: ACTIONS, placeholder: 'why?', inputType: 'multiline', timeout: 120, fallback: 'no' });

            const sent = (client.triggerHook.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
            expect(sent).toEqual({
                isEncrypted: true,
                ...FIELDS,
                actions: [{ id: 'yes', style: 'primary' }, { id: 'no', style: 'secondary' }],
                metadata: { inputType: 'multiline' },
                timeout: 120,
                fallback: 'no',
                hookType: 'combo',
                acceptsExit: true,
                acceptsFiles: true,
                sessionId: 'sess_1',
            });
            expect(JSON.stringify(sent)).not.toMatch(/Deploy|secret|Yes|why\?|proj/);
            // The whole question is inside the seal, so nothing was clipped into response.md.
            expect(client.requestUpload).not.toHaveBeenCalled();
            expect(sealMock.prepareAsk).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'proj · Deploy?', body: longBody, placeholder: 'why?' }),
                expect.anything(),
            );
        });

        it('returns the choice from the opened answer, opened for this question and its choices', async () => {
            ready();
            sealMock.openAnswer.mockResolvedValue({ ok: true, actionId: 'yes' });
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: SEALED_RESPONSE }));
            const { run } = setup();

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(parse(result)).toEqual({ actionId: 'yes', timedOut: false, hwipState: 'REMOTE' });
            expect(sealMock.openAnswer).toHaveBeenCalledWith(expect.objectContaining(SEALED_RESPONSE), 'ASK', ['yes', 'no'], expect.anything());
        });

        it('returns the typed text, and an exit ends REMOTE', async () => {
            ready();
            sealMock.openAnswer.mockResolvedValue({ ok: true, value: 'last words', exit: true });
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: SEALED_RESPONSE }));
            const { run } = setup();

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(parse(result)).toEqual({ value: 'last words', timedOut: false, hwipState: 'NORMAL' });
        });

        it('answer files: saves the sealed files under the event and puts their paths after the text', async () => {
            ready();
            const meta = { iv: 'IV', name: 'shot.png', type: 'image/png', size: 3 };
            sealMock.openAnswer.mockResolvedValue({ ok: true, value: 'see this', files: [meta], senderPublicKey: 'PHONE' });
            const wire = [{ fileKey: 'files/9', fileName: 'file', fileType: 'application/octet-stream', fileSize: 16, iv: 'IV', deviceKeyMap: { me: 'w' } }];
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { ...SEALED_RESPONSE, files: wire } }));
            filesMock.saveAnswerFiles.mockResolvedValue({ paths: ['/h/.hwip/attachments/e1/shot.png'], missing: ['log.txt: download failed'] });
            const downloadFile = vi.fn(async () => Buffer.from('x'));
            const { run } = setup({ downloadFile });

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(parse(result)).toEqual({
                value: 'see this\n/h/.hwip/attachments/e1/shot.png',
                files: ['/h/.hwip/attachments/e1/shot.png'],
                missingFiles: ['log.txt: download failed'],
                timedOut: false,
                hwipState: 'REMOTE',
            });
            const [eventId, given, metas, deps] = filesMock.saveAnswerFiles.mock.calls[0]!;
            expect([eventId, given, metas]).toEqual(['e1', wire, [meta]]);
            expect(deps).toMatchObject({ selfId: listenerDeviceId(), senderPublicKey: 'PHONE' });
            await deps.fetchBytes('files/9');
            expect(downloadFile).toHaveBeenCalledWith('files/9', expect.any(Number), undefined);
        });

        it('answer files: with no key on this machine, says so for each file instead of dropping them', async () => {
            ready();
            // The key goes away after the answer opened (a keystore that stopped loading).
            sealMock.openAnswer.mockImplementation(async () => {
                vi.mocked(getPublicKey).mockReturnValue(null);
                return { ok: true, value: 'see this', files: [{ iv: 'IV', name: 'shot.png', type: 'image/png', size: 3 }], senderPublicKey: 'PHONE' };
            });
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: SEALED_RESPONSE }));
            const { run } = setup();

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(parse(result)).toMatchObject({ value: 'see this', missingFiles: ['shot.png: no key on this machine'] });
            expect(filesMock.saveAnswerFiles).not.toHaveBeenCalled();
        });

        it('answer files: an answer with no files saves nothing', async () => {
            ready();
            sealMock.openAnswer.mockResolvedValue({ ok: true, value: 'plain' });
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: SEALED_RESPONSE }));
            const { run } = setup();

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(parse(result)).toEqual({ value: 'plain', timedOut: false, hwipState: 'REMOTE' });
            expect(filesMock.saveAnswerFiles).not.toHaveBeenCalled();
        });

        it('sends nothing, and says why, when the question cannot be sealed', async () => {
            sealMock.prepareAsk.mockResolvedValue({ kind: 'refused', cause: 'keystore' });
            const { client, run } = setup();

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(result.isError).toBe(true);
            expect(parse(result).error).toBe('SEALED_ASK_FAILED');
            expect(parse(result).message).toContain('keys did not load');
            expect(client.triggerHook).not.toHaveBeenCalled();
        });

        it('sends nothing, and names why, when this machine\'s key could not be registered', async () => {
            sealMock.prepareAsk.mockResolvedValue({ kind: 'refused', cause: 'self-unlisted', why: 'http 404' });
            const { client, run } = setup();

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(result.isError).toBe(true);
            expect(parse(result).error).toBe('SEALED_ASK_FAILED');
            expect(parse(result).message).toBe('sealed ask: could not register this machine\'s key in the account\'s device list (the server answered HTTP 404); the question was not sent');
            expect(client.triggerHook).not.toHaveBeenCalled();
        });

        it('sends nothing, and asks for the phone app, when the account lists no iPhone or Android app', async () => {
            sealMock.prepareAsk.mockResolvedValue({ kind: 'refused', cause: 'no-app' });
            const { client, run } = setup();

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(result.isError).toBe(true);
            expect(parse(result).error).toBe('NO_APP_DEVICE');
            expect(parse(result).message).toContain('sign in to the Hwip app on an iPhone or Android phone');
            expect(client.triggerHook).not.toHaveBeenCalled();
        });

        it('stops waiting for the lookups when the call is cancelled, and sends nothing', async () => {
            sealMock.prepareAsk.mockReturnValue(new Promise(() => undefined));
            const { client, run } = setup();
            const controller = new AbortController();

            const pending = run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 }, { sendNotification: vi.fn(), signal: controller.signal });
            controller.abort();
            const result = await pending;

            expect(parse(result)).toMatchObject({ error: 'ABORTED', message: expect.stringContaining('before the question was sent') });
            expect(client.triggerHook).not.toHaveBeenCalled();
        });

        it('says the keys failed after the answer came, not that the question was not sent', async () => {
            ready();
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: SEALED_RESPONSE }));
            const { run } = setup();
            // The send is scripted; the keys are checked again when the answer is opened, and are gone.
            vi.mocked(getKeyPair).mockReturnValue(null);

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(parse(result).message).toContain('could not be opened');
            expect(parse(result).message).not.toContain('was not sent');
        });

        it('is no answer when the answer does not check out', async () => {
            ready();
            sealMock.openAnswer.mockResolvedValue({ ok: false, cause: 'sender-mismatch' });
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: SEALED_RESPONSE }));
            const { run } = setup();

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(result.isError).toBe(true);
            expect(parse(result)).toEqual(expect.objectContaining({ error: 'SEALED_ASK_FAILED' }));
            expect(parse(result).actionId).toBeUndefined();
        });

        it('never reads the plaintext fields of the response', async () => {
            await realSeal();
            ready();
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { actionId: 'yes', value: 'approve', respondedDeviceId: 'dev_phone' } }));
            const { run } = setup();

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(result.isError).toBe(true);
            expect(parse(result).actionId).toBeUndefined();
        });

        it('loads this machine\'s keys before it opens the answer', async () => {
            ready();
            sealMock.openAnswer.mockResolvedValue({ ok: true, actionId: 'yes' });
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: SEALED_RESPONSE }));
            const { run } = setup();
            await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });
            const { cryptoReady } = await import('../crypto.js');
            // once, before opening (prepareAsk's own key load is mocked away)
            expect(vi.mocked(cryptoReady)).toHaveBeenCalledTimes(1);
        });

        it('reads the device list and trust file again when they failed to load, then gives up', async () => {
            vi.useFakeTimers();
            ready();
            sealMock.openAnswer.mockResolvedValue({ ok: false, cause: 'peer-unusable' });
            polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: SEALED_RESPONSE }));
            const { run } = setup();

            const pending = run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });
            await vi.advanceTimersByTimeAsync(5_000);
            const result = await pending;

            expect(sealMock.openAnswer).toHaveBeenCalledTimes(3);
            expect(result.isError).toBe(true);
        });

        it('sends nothing when this machine has no device keys', async () => {
            await realSeal();
            vi.mocked(getKeyPair).mockReturnValue(null);
            vi.mocked(getPublicKey).mockReturnValue(null);
            const { client, run } = setup();

            const result = await run({ title: 'Deploy?', actions: ACTIONS, inputType: 'text', timeout: 120 });

            expect(result.isError).toBe(true);
            expect(parse(result).message).toContain('keys did not load');
            expect(client.triggerHook).not.toHaveBeenCalled();
        });
    });
});

describe('sealDepsFor', () => {
    // A wrong path pins where the cli listener never looks.
    it('reads the trust file at TRUST_PATH, and is the machine the listener registers', () => {
        vi.mocked(getPublicKey).mockReturnValue('PUB');
        const deps = sealDepsFor({} as HwipApiClient, mkConfig());

        expect(deps.trustPath).toBe(TRUST_PATH);
        expect(deps.self()).toEqual({ deviceId: listenerDeviceId(), publicKey: 'PUB' });
    });

    it('has no self before the keys load', () => {
        vi.mocked(getPublicKey).mockReturnValue(null);
        expect(sealDepsFor({} as HwipApiClient, mkConfig()).self()).toBeNull();
    });
});
