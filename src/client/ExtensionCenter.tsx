import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  IconCloseOutline16, IconPersonalizationOutline16, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ExtensionCenterKey } from './locales.ts'
import type { ExtensionCatalogClient } from './catalog-api.ts'
import { ActivityPanel, InstalledPanel, UpdatesPanel } from './ManagementPanels.tsx'
import type { ExtensionManagementClient, ExtensionManagementContext } from './management-api.ts'
import { StorePanel } from './StorePanel.tsx'
import type { ExtensionCenterStore, ExtensionCenterView } from './store.ts'
import css from './ExtensionCenter.module.css'

/** Locale namespace registered by the Extension Center Client plugin. */
export const EXTENSION_CENTER_LOCALE = 'extension-center'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Product copy for the independent Extension Center shell. */
    'extension-center': ExtensionCenterKey
  }
}

const TABS = [
  { id: 'store', label: 'tab.store' },
  { id: 'installed', label: 'tab.installed' },
  { id: 'updates', label: 'tab.updates' },
  { id: 'activity', label: 'tab.activity' },
] as const satisfies readonly { id: ExtensionCenterView; label: ExtensionCenterKey }[]

/** Sidebar entry props composed from the owner, shared store, and locale seat. */
export type ExtensionCenterTriggerProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ExtensionCenterStore>
  & PropsLocale<typeof EXTENSION_CENTER_LOCALE>

/** Overlay entry props composed from the shared store and locale seat. */
export type ExtensionCenterOverlaySlotProps =
  PropsRuntime<'shell.overlay'>
  & PropsStore<ExtensionCenterStore>
  & PropsLocale<typeof EXTENSION_CENTER_LOCALE>

/** Overlay props used by direct source tests before the catalog client is captured. */
export type ExtensionCenterOverlayProps = ExtensionCenterOverlaySlotProps & {
  readonly catalog: ExtensionCatalogClient
  readonly management?: ExtensionManagementClient
  readonly managementContext?: ExtensionManagementContext
}

const DEFAULT_MANAGEMENT_CONTEXT: ExtensionManagementContext = {
  profileId: 'web',
  defaultScopeKey: 'profile:web',
}

/** Render the first-level sidebar action and restore focus after every dialog close path. */
export function ExtensionCenterTrigger({ wide, useStore, actions, t }: ExtensionCenterTriggerProps) {
  const open = useStore(state => state.open)
  const trigger = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus()
    wasOpen.current = open
  }, [open])

  return (
    <Tooltip label={t('trigger')} delayMs={500} disabled={wide}>
      <button
        ref={trigger}
        type="button"
        className={css.trigger}
        data-extension-center-entry="true"
        data-wide={wide ? 'true' : 'false'}
        aria-label={t('trigger')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={actions.openStore}
      >
        <IconPersonalizationOutline16 size={wide ? 16 : 18} aria-hidden="true" />
        {wide ? <span>{t('trigger')}</span> : null}
      </button>
    </Tooltip>
  )
}

/** Render the Store-default dialog from the additive shell overlay slot. */
export function ExtensionCenterOverlay({
  useStore, actions, t, catalog, management, managementContext = DEFAULT_MANAGEMENT_CONTEXT,
}: ExtensionCenterOverlayProps) {
  const open = useStore(state => state.open)
  const active = useStore(state => state.active)
  const id = useId()
  const surface = useRef<HTMLDivElement>(null)
  const storeTab = useRef<HTMLButtonElement>(null)
  const [catalogEntries, setCatalogEntries] = useState<Awaited<ReturnType<ExtensionCatalogClient['list']>>['entries']>([])
  const candidates = useMemo(() => new Map(catalogEntries.map(entry => [entry.candidateRef, entry])), [catalogEntries])

  useEffect(() => {
    if (open) storeTab.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) {
      setCatalogEntries([])
      return
    }
    const controller = new AbortController()
    setCatalogEntries([])
    catalog.list(controller.signal).then((snapshot) => {
      setCatalogEntries(snapshot.entries)
    }).catch(() => {
      if (!controller.signal.aborted) setCatalogEntries([])
    })
    return () => { controller.abort() }
  }, [catalog, open])

  useEffect(() => {
    if (!open) return
    const keepFocusInside = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const focusable = [...(surface.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled):not([tabindex="-1"]), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter(element => element.closest('[hidden]') === null)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keepFocusInside)
    return () => { document.removeEventListener('keydown', keepFocusInside) }
  }, [open])

  const tabId = (view: ExtensionCenterView): string => `${id}-tab-${view}`
  const panelId = (view: ExtensionCenterView): string => `${id}-panel-${view}`
  const moveTab = (event: React.KeyboardEvent<HTMLButtonElement>, current: ExtensionCenterView): void => {
    const index = TABS.findIndex(tab => tab.id === current)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    else return
    event.preventDefault()
    const view = TABS[next]?.id
    if (view === undefined) return
    actions.select(view)
    document.getElementById(tabId(view))?.focus()
  }

  return (
    <Modal
      open={open}
      onClose={actions.close}
      title={t('title')}
      headless
      className={css.dialog}
    >
      <div ref={surface} className={css.surface} data-extension-center-surface="true">
        <header className={css.header}>
          <div className={css.titleBlock}>
            <div className={css.eyebrow}>
              <span>{t('preview')}</span>
              <span className={css.host}>{t('host')}</span>
            </div>
            <h2>{t('title')}</h2>
            <p>{t('description')}</p>
          </div>
          <button type="button" className={css.close} aria-label={t('close')} onClick={actions.close}>
            <IconCloseOutline16 size={16} aria-hidden="true" />
          </button>
        </header>

        <div className={css.tabs} role="tablist" aria-label={t('views')}>
          {TABS.map(tab => (
            <button
              key={tab.id}
              ref={tab.id === 'store' ? storeTab : undefined}
              id={tabId(tab.id)}
              type="button"
              role="tab"
              aria-selected={active === tab.id}
              aria-controls={panelId(tab.id)}
              tabIndex={active === tab.id ? 0 : -1}
              onClick={() => { actions.select(tab.id) }}
              onKeyDown={(event) => { moveTab(event, tab.id) }}
            >
              {t(tab.label)}
            </button>
          ))}
        </div>

        <div className={css.panels}>
          {TABS.map(tab => (
            <section
              key={tab.id}
              id={panelId(tab.id)}
              role="tabpanel"
              aria-labelledby={tabId(tab.id)}
              hidden={active !== tab.id}
              className={css.panel}
            >
              {tab.id === 'store' && active === 'store' ? (
                <StorePanel t={t} catalog={catalog} management={management} context={managementContext} />
              ) : null}
              {tab.id === 'installed' && active === 'installed' ? (
                <InstalledPanel
                  management={management}
                  context={managementContext}
                  candidates={candidates}
                  t={t}
                />
              ) : null}
              {tab.id === 'updates' && active === 'updates' ? (
                <UpdatesPanel
                  management={management}
                  context={managementContext}
                  candidates={candidates}
                  t={t}
                />
              ) : null}
              {tab.id === 'activity' && active === 'activity' ? (
                <ActivityPanel
                  management={management}
                  context={managementContext}
                  candidates={candidates}
                  t={t}
                />
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/** Bind private catalog and management clients without placing them in generic slot options. */
export function bindExtensionCenterOverlay(
  catalog: ExtensionCatalogClient,
  management: ExtensionManagementClient,
  managementContext: ExtensionManagementContext = DEFAULT_MANAGEMENT_CONTEXT,
) {
  return function BoundExtensionCenterOverlay(props: ExtensionCenterOverlaySlotProps) {
    return <ExtensionCenterOverlay
      {...props}
      catalog={catalog}
      management={management}
      managementContext={managementContext}
    />
  }
}
