import { describe, expect, it } from 'vitest';
import { sliceChars } from './text-slice.js';

const REPLACEMENT = String.fromCharCode(0xfffd);

describe('sliceChars', () => {
    it('keeps a surrogate pair whole at the cut', () => {
        const out = sliceChars('a'.repeat(199) + '😀' + 'tail', 200);
        expect(out).toBe('a'.repeat(199) + '😀');
        expect(out).not.toContain(REPLACEMENT);
    });

    it('returns short text unchanged', () => {
        expect(sliceChars('abc', 200)).toBe('abc');
    });

    it('counts code points, not UTF-16 units', () => {
        expect(sliceChars('😀😀😀', 2)).toBe('😀😀');
    });
});
