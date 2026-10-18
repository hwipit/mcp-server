import { describe, expect, it } from 'vitest';
import { sanitizeText, recoverActions, UNKNOWN_STYLE } from './sanitize.js';

// The exact malformed hwip_ask body observed in the wild: the actions
// JSON leaked into the body because the `body` parameter was mis-closed.
const LEAKED_BODY = `# Tab back-gesture fix applied. Verify?

One-line change: AppShell.tsx NavLink + \`replace\`. Lint clean.

Commit now or test first?</body>
<parameter name="actions">[{"id":"commit","label":"Commit","style":"primary"},{"id":"test_first","label":"Test first"},{"id":"done","label":"Done"}]`;

describe('sanitizeText', () => {
  it('returns clean text unchanged', () => {
    expect(sanitizeText('Build finished — all tests green.')).toBe('Build finished — all tests green.');
  });

  it('passes undefined through', () => {
    expect(sanitizeText(undefined)).toBeUndefined();
  });

  it('cuts the leaked body at </body>, dropping the leaked markup', () => {
    const cleaned = sanitizeText(LEAKED_BODY);
    expect(cleaned?.endsWith('Commit now or test first?')).toBe(true);
    expect(cleaned).not.toContain('</body>');
    expect(cleaned).not.toContain('<parameter');
  });

  it('cuts at a bare <parameter name= marker', () => {
    expect(sanitizeText('Done.<parameter name="actions">[]')).toBe('Done.');
  });

  it('trims trailing whitespace left before the cut', () => {
    expect(sanitizeText('Done.   </body>')).toBe('Done.');
  });
});

describe('recoverActions', () => {
  it('recovers the actions array that leaked into the body', () => {
    const actions = recoverActions(LEAKED_BODY);
    expect(actions).toEqual([
      { id: 'commit', label: 'Commit', style: 'primary' },
      { id: 'test_first', label: 'Test first' },
      { id: 'done', label: 'Done' },
    ]);
  });

  const leaking = (actions: ReadonlyArray<{ id: string; label: string; style?: string | number | null }>): string => `Wipe it?</body>\n<parameter name="actions">${JSON.stringify(actions)}`;

  // A style in another case is the same style: read as it is meant, so the checks that go by it see it.
  it.each(['Danger', ' danger ', 'DANGER'])('reads a recovered style %j as danger', (style) => {
    expect(recoverActions(leaking([{ id: 'wipe', label: 'Wipe', style }]))).toEqual([{ id: 'wipe', label: 'Wipe', style: 'danger' }]);
  });

  // Not `undefined`: that is "nothing leaked", and the caller would send the question with no buttons and no word of it.
  it.each<[string, string | number | null]>([['a word that is no style', 'explode'], ['a number', 3], ['null', null]])(
    'says so, and recovers no button, when a style is %s',
    (_, style) => {
      expect(recoverActions(leaking([{ id: 'ok', label: 'OK' }, { id: 'wipe', label: 'Wipe', style }]))).toBe(UNKNOWN_STYLE);
    },
  );

  it('returns undefined when there is no leaked actions markup', () => {
    expect(recoverActions('Just a normal body, no leak.')).toBeUndefined();
  });

  it('returns undefined when the leaked segment is not valid JSON', () => {
    expect(recoverActions('body</body><parameter name="actions">[not json')).toBeUndefined();
  });

  it('rejects a parsed array whose items lack id/label', () => {
    expect(recoverActions('x<parameter name="actions">[{"foo":1}]')).toBeUndefined();
  });

  it('rejects a leaked array outside the 1–4 contract', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: `A${i}` }));
    expect(recoverActions(`x<parameter name="actions">${JSON.stringify(five)}`)).toBeUndefined();
    expect(recoverActions('x<parameter name="actions">[]')).toBeUndefined();
  });

  it('rejects leaked ids and labels past their caps', () => {
    expect(recoverActions(`x<parameter name="actions">${JSON.stringify([{ id: 'i'.repeat(51), label: 'ok' }])}`)).toBeUndefined();
    expect(recoverActions(`x<parameter name="actions">${JSON.stringify([{ id: 'ok', label: 'l'.repeat(101) }])}`)).toBeUndefined();
  });
});
