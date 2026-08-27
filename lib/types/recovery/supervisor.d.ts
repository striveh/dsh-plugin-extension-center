#!/usr/bin/env node
/**
 * Dependency-free POSIX supervisor for one bound official DSH CLI mutation.
 *
 * The caller creates this process as a new process-group leader and keeps its
 * stdin pipe open. EOF means the caller disappeared, including `SIGKILL`; the
 * supervisor then terminates the whole group containing DSH and pnpm.
 */
export {};
//# sourceMappingURL=supervisor.d.ts.map
