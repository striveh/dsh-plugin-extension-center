import { existsSync, writeFileSync } from 'node:fs'
import { canonicalSha256 } from '../../src/domain/index.ts'
import { CenterMcpConnectionStore } from '../../src/internal/mcp/store.ts'
import type { CenterMcpConnectionDesired } from '../../src/internal/mcp/types.ts'

const [root, id, startedPath, enteredPath, releasePath, holdValue] = process.argv.slice(2)
if ([root, id, startedPath, enteredPath, releasePath, holdValue].some(value => value === undefined)) {
  throw new Error('MCP store worker arguments are incomplete')
}

const desired: CenterMcpConnectionDesired = {
  id: id!,
  enabled: false,
  transport: {
    transport: 'stdio',
    command: process.execPath,
    args: [id!],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 10_000,
    reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 500, maxAttempts: 3 },
  },
}
const mutationId = `configure-${id!}`
const store = new CenterMcpConnectionStore(root!)
writeFileSync(startedPath!, '')
await store.mutate(mutationId, { mutationId, desired, expectedRevision: 0 }, state => {
  writeFileSync(enteredPath!, '')
  if (holdValue === 'hold') {
    const waitCell = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(releasePath!)) Atomics.wait(waitCell, 0, 0, 20)
  }
  state.revision += 1
  state.connections.push({ desired, revision: 1 })
  return {
    mutationId,
    operation: 'configure',
    id: id!,
    revision: 1,
    snapshotRevision: state.revision,
    changed: true,
    desiredDigest: canonicalSha256(desired),
  }
})
store.close()
