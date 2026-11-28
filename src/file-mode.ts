import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'fs';

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

export type SensitiveFs = Pick<typeof import('fs'), 'openSync' | 'fstatSync' | 'readFileSync' | 'closeSync'>;

/**
 * Read a private file the way it was judged: open once, judge the open descriptor (`fstat`), read that same
 * descriptor — a file swapped in between a path check and a path read is never the one that was read. Null
 * when there is no such file (ENOENT). Any other error (EACCES, ELOOP, EIO …) means the file could not be
 * judged, which is a refusal, never a pass. Judged strictly: see `sensitiveFileModeProblem`.
 * A symlink is followed; the descriptor is the target. Windows has no owner or mode to read: judged by nothing.
 */
export const readPrivateFile = (
    file: string,
    messages: SensitiveFileMessages,
    onWarning: (line: string) => void,
    io: SensitiveFs = { openSync, fstatSync, readFileSync, closeSync },
    env: { platform?: NodeJS.Platform; getuid?: () => number } = {},
): string | null => {
    const platform = env.platform ?? process.platform;
    const getuid = env.getuid ?? process.getuid;
    const judged = platform !== 'win32' && typeof getuid === 'function';
    let fd: number;
    try {
        fd = io.openSync(file, constants.O_RDONLY);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return null;
        if (!judged) throw err;
        throw new Error(`${file} cannot be checked (${code ?? (err as Error).message}), refusing to use it`);
    }
    try {
        if (judged) {
            const problem = sensitiveFileModeProblem(io.fstatSync(fd), getuid!(), file, messages, true);
            if (problem) {
                onWarning(problem.why);
                if (problem.refuse) throw new Error(problem.why);
            }
        }
        return io.readFileSync(fd, 'utf-8');
    } finally {
        io.closeSync(fd);
    }
};

/** Each message once per process: a loader that runs again (a send retried, a second reader) would repeat it. */
const toldOnce = new Set<string>();

export const sayOnce = (line: string): void => {
    if (toldOnce.has(line)) return;
    toldOnce.add(line);
    console.error(line);
};
