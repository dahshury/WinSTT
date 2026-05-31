/**
 * Indirection re-export of the stt-process functions consumed by other IPC
 * modules (currently settings.ts). Test files mock this thin wrapper instead
 * of `./stt-process` directly so stt-process.test.ts can keep importing the
 * real module without picking up another test's stub. See ADR in
 * `electron/ipc/stt-process.test.ts` (top-of-file comment) for context.
 */
export { isSttProcessRunning, restartSttProcess } from "./stt-process";
