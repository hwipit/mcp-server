/**
 * Defensive cleanup for tool arguments.
 *
 * An agent occasionally emits a malformed tool call where a parameter's
 * closing tag is wrong, so the serialized markup of the *following*
 * parameters bleeds into an earlier string argument.
 *
 * Observed in the wild — a hwip_ask `body` arrived as:
 *
 *   "...Commit now or test first?</body>
 *    <parameter name=\"actions\">[{\"id\":\"commit\",...}]"
 *
 * The actions JSON leaked into `body`, and `actions` itself arrived
 * undefined — so the push showed the raw markup and no buttons.
 *
 * sanitizeText strips the leaked markup; recoverActions pulls the
 * swallowed actions array back out so the call still works.
 */

/** A button's styles: the tool's schema (tools/ask.ts) is built of these, and a recovered call is held to them. */
export const STYLES = ['primary', 'secondary', 'danger'] as const;

export interface RecoveredAction {
  id: string;
  label: string;
  style?: (typeof STYLES)[number];
}

// Markers that should never appear in a real notification body — their
// presence means tool-call markup has leaked in. Cut at the earliest one.
const LEAK_MARKERS = ['</body>', '</parameter>', '<parameter name=', '<parameter '];

const findLeakStart = (text: string): number => {
  let earliest = -1;
  for (const marker of LEAK_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  return earliest;
};

/**
 * Strip leaked tool-call markup from a free-text argument. Returns the
 * text unchanged when no leak is detected.
 */
export const sanitizeText = (text: string | undefined): string | undefined => {
  if (!text) return text;
  const cut = findLeakStart(text);
  return cut === -1 ? text : text.slice(0, cut).trimEnd();
};

// Bounds mirror the hwip_ask contract (1–4 actions). Length caps on the
// recovered strings keep a malformed/oversized leak from producing absurd
// buttons; the real server enforces its own limits too.
const isActionArray = (value: unknown): value is RecoveredAction[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 4 &&
  value.every(
    (a) =>
      a &&
      typeof (a as RecoveredAction).id === 'string' &&
      (a as RecoveredAction).id.length <= 50 &&
      typeof (a as RecoveredAction).label === 'string' &&
      (a as RecoveredAction).label.length <= 100,
  );

/**
 * The style as the tool's schema would have it: a leaked call skipped that schema, and what goes by
 * `style` after it (the danger check on a fallback) compares the exact word. Another case is the same
 * style; anything else is not one, and null says so.
 */
const styleOf = (value: unknown): RecoveredAction['style'] | null => {
  if (value === undefined) return undefined;
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STYLES.find((style) => style === word) ?? null;
};

/** What `recoverActions` gives for buttons that leaked whole with a `style` that is none: not them, and not "nothing leaked". */
export const UNKNOWN_STYLE = 'unknown-style';

/**
 * Recover an `actions` array that leaked into the body of a malformed
 * hwip_ask call. Returns undefined when nothing parseable is found, and
 * `UNKNOWN_STYLE` when the buttons were there and one has a `style` that
 * is not one of the tool's: the schema would have refused that call, and
 * its caller is to refuse it too, not ask with no buttons.
 */
export const recoverActions = (text: string | undefined): RecoveredAction[] | typeof UNKNOWN_STYLE | undefined => {
  if (!text) return undefined;
  const marker = text.search(/<(?:antml:)?parameter name="actions">/);
  if (marker === -1) return undefined;

  const after = text.slice(marker);
  const start = after.indexOf('[');
  const end = after.lastIndexOf(']');
  if (start === -1 || end <= start) return undefined;

  try {
    const parsed: unknown = JSON.parse(after.slice(start, end + 1));
    if (!isActionArray(parsed)) return undefined;
    const actions: RecoveredAction[] = [];
    for (const action of parsed) {
      const style = styleOf((action as { style?: unknown }).style); // parsed JSON: `style` is whatever the leak held
      if (style === null) return UNKNOWN_STYLE;
      actions.push(style === undefined ? action : { ...action, style });
    }
    return actions;
  } catch {
    return undefined;
  }
};
