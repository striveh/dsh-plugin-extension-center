import type { StoreHandle, StoreInstance } from '@deepseek-ai/dsh-client-ui-slots'

/** Extension Center top-level view identifiers. */
export type ExtensionCenterView = 'store' | 'installed' | 'updates' | 'activity'

/** Root-scoped viewing state shared by the sidebar trigger and shell overlay. */
export interface ExtensionCenterState {
  open: boolean
  active: ExtensionCenterView
}

/** Complete write set for transient Extension Center viewing state. */
export type ExtensionCenterActions = {
  openStore: (draft: ExtensionCenterState) => void
  close: (draft: ExtensionCenterState) => void
  select: (draft: ExtensionCenterState, view: ExtensionCenterView) => void
}

/** Shared store handle type used by both additive slot entries. */
export type ExtensionCenterStore = StoreHandle<ExtensionCenterState, ExtensionCenterActions>

/** Return whether a transient update retained the exact visible state. */
function sameState(left: ExtensionCenterState, right: ExtensionCenterState): boolean {
  return left.open === right.open && left.active === right.active
}

/** Create one framework-neutral store instance from the shared declaration. */
function createStoreInstance(
  spec: ExtensionCenterStore['spec'],
): StoreInstance<ExtensionCenterState, ExtensionCenterActions> {
  let state = spec.init()
  const listeners = new Set<() => void>()
  const update = (mutate: (draft: ExtensionCenterState) => void): void => {
    // This state is deliberately flat; a shallow copy is its complete mutable draft.
    const next = { ...state }
    mutate(next)
    if (sameState(state, next)) return
    state = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('extension-center store subscriber failed:', error)
      }
    }
  }
  return {
    actions: {
      openStore: () => { update(spec.actions.openStore) },
      close: () => { update(spec.actions.close) },
      select: (view) => { update(draft => { spec.actions.select(draft, view) }) },
    },
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    // The Extension Center view state is intentionally transient.
    clearPersisted() {},
  }
}

/**
 * Create one transient root store for the two Extension Center entries.
 * @returns A fresh handle owned by one Client plugin application.
 */
export function createExtensionCenterStore(): ExtensionCenterStore {
  const spec: ExtensionCenterStore['spec'] = {
    init: (): ExtensionCenterState => ({ open: false, active: 'store' }),
    actions: {
      openStore: (draft) => {
        draft.active = 'store'
        draft.open = true
      },
      close: (draft) => { draft.open = false },
      select: (draft, view: ExtensionCenterView) => { draft.active = view },
    },
  }
  return {
    spec,
    create: () => createStoreInstance(spec),
  }
}
