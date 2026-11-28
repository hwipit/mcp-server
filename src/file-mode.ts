import { statSync } from 'fs';

export type SensitiveFileProblem = { refuse: boolean; why: string };

export type SensitiveFileMessages = {
    ownerRefusal: (file: string, uid: number) => string;
    worldWritableRefusal: (file: string, mode: string) => string;
    /** Only a `strict` judge needs it. */
    exposedRefusal?: (file: string, mode: string) => string;
    exposedWarning: (file: string, mode: string) => string;
};

/**
 * Why this machine should not trust a sensitive file as it stands, or null. A file another user owns, or anyone
 * can write, is refused (root may read what a user owns — sudo). What the group can read or write, or others
 * can read, is a warning (`strict: false`, a user-private group makes every file 664) or a refusal (`strict: true`,
 * for a private key that nobody but its owner may touch).
 */
export const sensitiveFileModeProblem = (
    st: { uid: number; mode: number },
    myUid: number,
    file: string,
    messages: SensitiveFileMessages,
    strict = false,
): SensitiveFileProblem | null => {
    const mode = (st.mode & 0o777).toString(8);
    if (st.uid !== myUid && myUid !== 0) return { refuse: true, why: messages.ownerRefusal(file, st.uid) };
    if (st.mode & 0o002) return { refuse: true, why: messages.worldWritableRefusal(file, mode) };
    if (strict && messages.exposedRefusal && st.mode & 0o077) return { refuse: true, why: messages.exposedRefusal(file, mode) };
    if (st.mode & 0o064) return { refuse: false, why: messages.exposedWarning(file, mode) };
    return null;
};

/** The file as it is now. A symlink is judged by what it points at. Windows has no owner or mode to read. */
export const sensitiveFileProblem = (
    file: string,
    messages: SensitiveFileMessages,
    strict = false,
): SensitiveFileProblem | null => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
    try {
        return sensitiveFileModeProblem(statSync(file), process.getuid(), file, messages, strict);
    } catch {
        return null;
    }
};

/** Each message once per process: a loader that runs again (a send retried, a second reader) would repeat it. */
const toldOnce = new Set<string>();

export const sayOnce = (line: string): void => {
    if (toldOnce.has(line)) return;
    toldOnce.add(line);
    console.error(line);
};
