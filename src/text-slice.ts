/** The first `max` characters of `text`, cut between code points so a surrogate pair is never split. */
export const sliceChars = (text: string, max: number): string => {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join('');
};
