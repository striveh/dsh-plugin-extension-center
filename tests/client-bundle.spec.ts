import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PLUGIN_ID = 'dsh-plugin-extension-center'

interface Handoff {
  id: string
  factory: (require: (specifier: string) => unknown) => ArtifactExports
}

interface ArtifactExports {
  inject: readonly string[]
  apply: (ctx: unknown) => void
}

interface ModuleWindow extends Window {
  __ModuleLoader__?: { load(handoff: Handoff): void }
}

afterEach(() => {
  delete (window as ModuleWindow).__ModuleLoader__
  for (const style of document.querySelectorAll('style[data-plugin]')) style.remove()
})

function bundleCode(): string {
  return readFileSync(resolve('lib/client.js'), 'utf8')
}

function loadArtifact(): { handoff: Handoff; exports: ArtifactExports; required: string[] } {
  let handoff: Handoff | undefined
  ;(window as ModuleWindow).__ModuleLoader__ = { load(value) { handoff = value } }
  // The checked-in lazy-CJS artifact is the subject of this ABI test.
  // eslint-disable-next-line no-new-func
  new Function(bundleCode())()
  if (handoff === undefined) throw new Error('Client artifact did not call window.__ModuleLoader__.load')
  const required: string[] = []
  const modules = new Map<string, unknown>([
    ['react', {}],
    ['react/jsx-runtime', {}],
    ['@deepseek-ai/dsh-client-ui-primitives', {}],
    ['@deepseek-ai/dsh-client-runtime/client', {
      defineStore: (spec: unknown) => ({ spec, create: vi.fn() }),
    }],
  ])
  const exports = handoff.factory((specifier) => {
    required.push(specifier)
    if (!modules.has(specifier)) throw new Error(`unexpected browser require: ${specifier}`)
    return modules.get(specifier)
  })
  return { handoff, exports, required }
}

/** Convert one slots.inject callback result into an idempotent disposer. */
function disposerOf(value: unknown): () => void {
  const disposers = typeof value === 'function'
    ? [value as () => void]
    : value != null && Symbol.iterator in Object(value)
      ? [...(value as Iterable<() => void>)]
      : []
  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}

describe('built Client lazy-CJS ABI', () => {
  it('uses only rc.2 baseline module ids and exposes the exact plugin body', () => {
    const artifact = loadArtifact()
    expect(artifact.handoff.id).toBe(PLUGIN_ID)
    expect(artifact.exports.inject).toEqual(['connection', 'slots', 'locale'])
    expect(artifact.exports.apply).toBeTypeOf('function')
    expect(new Set(artifact.required)).toEqual(new Set([
      'react', 'react/jsx-runtime',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-runtime/client',
    ]))
    expect(bundleCode()).not.toContain(resolve('.'))
    expect(bundleCode()).not.toContain('extension_center_request_acquisition')
  })

  it('registers only two additive entries and removes entries, copy, and style on disposal', () => {
    const artifact = loadArtifact()
    const effects: Array<() => void> = []
    const entries: Array<{ options: Record<string, unknown>; component: unknown }> = []
    let injectDepth = 0
    const unregisterDictionary = vi.fn()
    const ctx = {
      get(service: string) {
        expect(service).toBe('connection')
        return { rpc: { call: vi.fn() } }
      },
      locale: {
        register(namespace: string, dictionaries: unknown) {
          expect(namespace).toBe('extension-center')
          expect(dictionaries).toMatchObject({ en: { title: 'Extension Store' }, zh: { title: '扩展商店' } })
          return unregisterDictionary
        },
      },
      effect(setup: () => unknown) {
        effects.push(disposerOf(setup()))
      },
      slots: {
        inject(key: string, setup: () => unknown) {
          expect(['sidebar.footer.action', 'shell.overlay']).toContain(key)
          injectDepth += 1
          const dispose = disposerOf(setup())
          injectDepth -= 1
          if (injectDepth === 0) effects.push(dispose)
          return dispose
        },
        register(options: Record<string, unknown>, component: unknown) {
          const entry = { options, component }
          entries.push(entry)
          return () => {
            const index = entries.indexOf(entry)
            if (index >= 0) entries.splice(index, 1)
          }
        },
      },
    }

    artifact.exports.apply(ctx)
    expect(entries.map(entry => entry.options.name)).toEqual(['sidebar.footer.action', 'shell.overlay'])
    expect(entries.map(entry => entry.options.id)).toEqual(['extension-center', 'extension-center'])
    expect(entries[0]?.options.store).toBe(entries[1]?.options.store)
    expect(document.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)).toHaveLength(1)

    for (const dispose of effects.reverse()) dispose()
    expect(entries).toHaveLength(0)
    expect(unregisterDictionary).toHaveBeenCalledOnce()
    expect(document.querySelector(`style[data-plugin="${PLUGIN_ID}"]`)).toBeNull()
  })
})
