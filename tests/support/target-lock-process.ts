import { FileTargetLock } from '../../src/host/target-lock.ts'
import { OperationRunner } from '../../src/service/operation-runner.ts'

interface ParentCommand {
  readonly command: 'release' | 'crash'
}

function notify(value: Readonly<Record<string, unknown>>): void {
  if (process.send === undefined) throw new Error('target-lock process requires an IPC channel')
  process.send(value)
}

function finish(value: Readonly<Record<string, unknown>>, exitCode: number): void {
  if (process.send === undefined) throw new Error('target-lock process requires an IPC channel')
  process.send(value, () => {
    process.exitCode = exitCode
    process.disconnect()
  })
}

async function own(root: string, targetKey: string, operationId: string): Promise<void> {
  const lock = new FileTargetLock(root)
  await lock.acquire(targetKey, operationId)
  notify({ event: 'acquired' })
  process.on('message', (value: ParentCommand) => {
    if (value.command === 'crash') {
      process.disconnect()
      process.exit(17)
    }
    if (value.command !== 'release') return
    void lock.release(targetKey, operationId).then(() => {
      finish({ event: 'released' }, 0)
    }, error => {
      finish({ event: 'error', message: error instanceof Error ? error.message : String(error) }, 1)
    })
  })
}

async function recover(root: string, targetKey: string): Promise<void> {
  const locks = new FileTargetLock(root)
  const runner = new OperationRunner(
    {} as never,
    { list: () => Promise.resolve([]) } as never,
    {
      list: () => Promise.resolve([]),
      listReservations: () => Promise.resolve([]),
    } as never,
    locks,
    {} as never,
    {} as never,
    {} as never,
  )
  await runner.recover(new AbortController().signal)
  let competingResult = 'acquired'
  try {
    await locks.acquire(targetKey, 'operation:competing-process')
    await locks.release(targetKey, 'operation:competing-process')
  } catch (error: unknown) {
    competingResult = error instanceof Error ? error.message : String(error)
  }
  finish({ event: 'recovered', competingResult }, 0)
}

const [mode, root, targetKey, operationId] = process.argv.slice(2)
if (root === undefined || targetKey === undefined) throw new Error('target-lock process arguments are incomplete')
if (mode === 'owner') {
  if (operationId === undefined) throw new Error('target-lock owner operation id is missing')
  await own(root, targetKey, operationId)
} else if (mode === 'recover') {
  await recover(root, targetKey)
} else {
  throw new Error(`target-lock process mode is unsupported: ${String(mode)}`)
}
