import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { durableUnlink, type DurableUnlinkOperations } from '../src/host/durable-unlink.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('durableUnlink', () => {
  it('removes the exact file before synchronizing its parent directory', async () => {
    const events: string[] = []
    const operations: DurableUnlinkOperations = {
      remove: async (path, options) => {
        events.push(`remove:${path}:${String(options.force)}`)
      },
      synchronize: async directory => {
        events.push(`sync:${directory}`)
      },
    }
    const path = join(tmpdir(), 'extension-managed', 'state', 'record.json')

    await durableUnlink(path, { force: true }, operations)

    expect(events).toEqual([
      `remove:${path}:true`,
      `sync:${dirname(path)}`,
    ])
  })

  it('propagates a directory synchronization failure after the file is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'extension-durable-unlink-'))
    roots.push(root)
    const path = join(root, 'record.json')
    await writeFile(path, 'durable\n', 'utf8')
    await expect(durableUnlink(path, {}, {
      remove: (target, options) => rm(target, options),
      synchronize: () => Promise.reject(new Error('simulated directory fsync failure')),
    })).rejects.toThrow('simulated directory fsync failure')
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not synchronize the directory when removal fails', async () => {
    let synchronizeCalls = 0

    await expect(durableUnlink(join(tmpdir(), 'extension-managed', 'state', 'record.json'), {}, {
      remove: () => Promise.reject(new Error('simulated unlink failure')),
      synchronize: async () => { synchronizeCalls += 1 },
    })).rejects.toThrow('simulated unlink failure')
    expect(synchronizeCalls).toBe(0)
  })
})
