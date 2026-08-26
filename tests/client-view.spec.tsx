import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCloseOutline16: () => <svg aria-hidden="true" />,
  IconPersonalizationOutline16: () => <svg aria-hidden="true" />,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  Modal: ({ open, onClose, title, children, className }: {
    open: boolean
    onClose: () => void
    title: string
    children: ReactNode
    className?: string
  }) => {
    useEffect(() => {
      if (!open) return
      const closeOnEscape = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') onClose()
      }
      document.addEventListener('keydown', closeOnEscape)
      return () => { document.removeEventListener('keydown', closeOnEscape) }
    }, [onClose, open])
    return open
      ? <div role="dialog" aria-modal="true" aria-label={title} className={className}>{children}</div>
      : null
  },
}))

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  defineStore: (spec: {
    init: () => Record<string, unknown>
    actions: Record<string, (draft: Record<string, unknown>, ...args: unknown[]) => void>
  }) => ({
    spec,
    create: () => {
      let state = spec.init()
      const listeners = new Set<() => void>()
      const actions = Object.fromEntries(Object.entries(spec.actions).map(([name, mutate]) => [
        name,
        (...args: unknown[]) => {
          const draft = { ...state }
          mutate(draft, ...args)
          state = draft
          for (const listener of listeners) listener()
        },
      ]))
      return {
        actions,
        getSnapshot: () => state,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    },
  }),
}))
import {
  ExtensionCenterOverlay, type ExtensionCenterOverlayProps,
  ExtensionCenterTrigger, type ExtensionCenterTriggerProps,
} from '../src/client/ExtensionCenter.tsx'
import type { ExtensionCatalogClient } from '../src/client/catalog-api.ts'
import { en, zh, type ExtensionCenterKey } from '../src/client/locales.ts'
import { createExtensionCenterStore } from '../src/client/store.ts'
import { catalogListResponse, verifyBootstrapCatalog } from '../src/catalog.ts'

afterEach(() => { cleanup() })

/** Mount both slot occupants over one real rc.2 store engine instance. */
const verifiedCatalog = catalogListResponse(verifyBootstrapCatalog(Date.parse('2026-08-25T10:15:00.000Z')))

function renderCenter(
  dictionary: Record<ExtensionCenterKey, string> = en,
  catalog: ExtensionCatalogClient = { list: async () => verifiedCatalog },
) {
  const instance = createExtensionCenterStore().create()
  const t = (key: ExtensionCenterKey): string => dictionary[key]
  function Harness() {
    const useStore = <Selected,>(selector: (state: ReturnType<typeof instance.getSnapshot>) => Selected): Selected =>
      useSyncExternalStore(instance.subscribe, () => selector(instance.getSnapshot()))
    const shared = { actions: instance.actions, useStore, t }
    return (
      <>
        <ExtensionCenterTrigger {...({ ...shared, wide: true } as ExtensionCenterTriggerProps)} />
        <ExtensionCenterOverlay {...({ ...shared, catalog } as ExtensionCenterOverlayProps)} />
      </>
    )
  }
  return render(<Harness />)
}

describe('rc.2 signed read-only Extension Store', () => {
  it('opens Store by default, switches all associated panels, and resets on reopen', async () => {
    renderCenter()
    const trigger = screen.getByRole('button', { name: 'Extensions' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Extension Store' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const tablist = within(dialog).getByRole('tablist', { name: 'Extension Center views' })
    const labels = ['Store', 'Installed', 'Updates', 'Activity & Recovery']
    const tabs = labels.map(label => within(tablist).getByRole('tab', { name: label }))
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs.slice(1).every(tab => tab.getAttribute('aria-selected') === 'false')).toBe(true)
    await waitFor(() => { expect(tabs[0]).toHaveFocus() })
    await within(dialog).findByText('Signed catalog verified')
    const close = within(dialog).getByRole('button', { name: 'Close Extension Store' })
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    const lastFocusable = document.activeElement
    expect(lastFocusable).not.toBe(close)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(close).toHaveFocus()
    tabs[0]!.focus()

    for (const tab of tabs) {
      const controls = tab.getAttribute('aria-controls')
      expect(controls).not.toBeNull()
      const panel = document.getElementById(controls!)
      expect(panel).not.toBeNull()
      expect(panel).toHaveAttribute('aria-labelledby', tab.id)
    }

    fireEvent.click(tabs[1]!)
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(within(dialog).getByRole('tabpanel', { name: 'Installed' })).toBeVisible()

    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' })
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[2]).toHaveFocus()
    fireEvent.keyDown(tabs[2]!, { key: 'End' })
    expect(tabs[3]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tabs[3]!, { key: 'Home' })
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Extension Store' })).toBeNull() })
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    expect(within(screen.getByRole('dialog', { name: 'Extension Store' }))
      .getByRole('tab', { name: 'Store' })).toHaveAttribute('aria-selected', 'true')
  })

  it('searches, filters, compares, and discloses three signed candidate kinds locally', async () => {
    renderCenter()
    fireEvent.click(screen.getByRole('button', { name: 'Extensions' }))
    const dialog = screen.getByRole('dialog', { name: 'Extension Store' })
    const storePanel = within(dialog).getByRole('tabpanel', { name: 'Store' })
    expect(within(dialog).getByText('Read-only catalog preview')).toBeVisible()
    expect(await within(storePanel).findByText('Signed catalog verified')).toBeVisible()
    expect(within(storePanel).getByRole('heading', { name: 'DSH Capability Resolver' })).toBeVisible()
    expect(within(storePanel).getByRole('heading', { name: 'Filesystem MCP' })).toBeVisible()
    expect(within(storePanel).getByRole('heading', { name: 'Documentation Writer' })).toBeVisible()
    expect(within(storePanel).getAllByRole('heading', { level: 4 }).map(heading => heading.textContent)).toEqual([
      'Documentation Writer', 'DSH Capability Resolver', 'Filesystem MCP',
    ])

    const search = within(storePanel).getByRole('searchbox', { name: 'Search extensions' })
    fireEvent.change(search, { target: { value: 'documentation' } })
    expect(within(storePanel).queryByRole('heading', { name: 'Filesystem MCP' })).toBeNull()
    expect(within(storePanel).getByRole('heading', { name: 'Documentation Writer' })).toBeVisible()
    fireEvent.change(search, { target: { value: 'striveh' } })
    expect(within(storePanel).getByRole('heading', { name: 'DSH Capability Resolver' })).toBeVisible()
    expect(within(storePanel).queryByRole('heading', { name: 'Documentation Writer' })).toBeNull()
    fireEvent.change(search, { target: { value: 'user-selected roots' } })
    expect(within(storePanel).getByRole('heading', { name: 'Filesystem MCP' })).toBeVisible()
    fireEvent.change(search, { target: { value: 'stdio' } })
    expect(within(storePanel).getByRole('heading', { name: 'Filesystem MCP' })).toBeVisible()
    fireEvent.change(search, { target: { value: '' } })
    const type = within(storePanel).getByRole('combobox', { name: 'Type' })
    fireEvent.change(type, { target: { value: 'mcp' } })
    expect(within(storePanel).getByRole('heading', { name: 'Filesystem MCP' })).toBeVisible()
    expect(within(storePanel).queryByRole('heading', { name: 'Documentation Writer' })).toBeNull()
    fireEvent.change(type, { target: { value: 'all' } })
    const scope = within(storePanel).getByRole('combobox', { name: 'Scope' })
    fireEvent.change(scope, { target: { value: 'project' } })
    expect(within(storePanel).getByRole('heading', { name: 'Documentation Writer' })).toBeVisible()
    expect(within(storePanel).queryByRole('heading', { name: 'Filesystem MCP' })).toBeNull()
    fireEvent.change(scope, { target: { value: 'all' } })
    const configuration = within(storePanel).getByRole('combobox', { name: 'Configuration' })
    fireEvent.change(configuration, { target: { value: 'required' } })
    expect(within(storePanel).getByRole('heading', { name: 'Filesystem MCP' })).toBeVisible()
    fireEvent.change(configuration, { target: { value: 'all' } })
    const authority = within(storePanel).getByRole('combobox', { name: 'Authority' })
    fireEvent.change(authority, { target: { value: 'model-context' } })
    expect(within(storePanel).getByRole('heading', { name: 'Documentation Writer' })).toBeVisible()
    expect(within(storePanel).getByRole('heading', { name: 'DSH Capability Resolver' })).toBeVisible()
    expect(within(storePanel).queryByRole('heading', { name: 'Filesystem MCP' })).toBeNull()
    fireEvent.change(authority, { target: { value: 'all' } })
    const lifecycle = within(storePanel).getByRole('combobox', { name: 'Lifecycle' })
    fireEvent.change(lifecycle, { target: { value: 'complete' } })
    expect(within(storePanel).getByRole('heading', { name: 'No admitted candidate matches' })).toBeVisible()
    fireEvent.change(lifecycle, { target: { value: 'blocked' } })
    expect(within(storePanel).getAllByRole('heading', { level: 4 })).toHaveLength(3)
    fireEvent.change(lifecycle, { target: { value: 'all' } })

    const addButtons = within(storePanel).getAllByRole('button', { name: 'Add to compare' })
    addButtons.forEach(button => { fireEvent.click(button) })
    const comparisonTrigger = within(storePanel).getByRole('button', { name: 'Compare selected (3/3)' })
    fireEvent.click(comparisonTrigger)
    const comparison = within(storePanel).getByRole('heading', { name: 'Candidate comparison' }).closest('section')
    if (comparison === null) throw new Error('comparison section missing')
    expect(comparison).toHaveFocus()
    expect(within(comparison).getByRole('columnheader', { name: 'DSH Capability Resolver' })).toBeVisible()
    expect(within(comparison).getByRole('columnheader', { name: 'Filesystem MCP' })).toBeVisible()
    expect(within(comparison).getByRole('columnheader', { name: 'Documentation Writer' })).toBeVisible()
    expect(within(comparison).getByRole('rowheader', { name: 'Acquisition authority' })).toBeVisible()
    expect(within(comparison).getByRole('rowheader', { name: 'Runtime authority' })).toBeVisible()
    expect(within(comparison).getByRole('rowheader', { name: 'Components' })).toBeVisible()
    expect(within(comparison).getByRole('rowheader', { name: 'Compatibility evidence' })).toBeVisible()
    expect(within(comparison).getByRole('rowheader', { name: 'Dependencies' })).toBeVisible()
    expect(within(comparison).getByRole('rowheader', { name: 'Conflicts' })).toBeVisible()
    expect(within(comparison).getByRole('rowheader', { name: 'Verification evidence' })).toBeVisible()
    for (const label of [
      'Install availability', 'Configure availability', 'Update availability', 'Uninstall availability', 'Restore availability',
    ]) {
      const row = within(comparison).getByRole('rowheader', { name: label }).closest('tr')
      if (row === null) throw new Error(`${label} row missing`)
      expect(within(row).getAllByRole('cell').map(cell => cell.textContent)).toEqual([
        'Unavailable · unavailable(host-capability)',
        'Unavailable · unavailable(host-capability)',
        'Unavailable · unavailable(host-capability)',
      ])
    }
    fireEvent.click(within(comparison).getByRole('button', { name: 'Close comparison' }))
    expect(comparisonTrigger).toHaveFocus()

    const filesystem = within(storePanel).getByRole('heading', { name: 'Filesystem MCP' }).closest('article')
    if (filesystem === null) throw new Error('Filesystem card missing')
    const detailTrigger = within(filesystem).getByRole('button', { name: 'View details' })
    fireEvent.click(detailTrigger)
    const details = within(storePanel).getByRole('heading', { level: 3, name: 'Filesystem MCP' }).closest('section')
    if (details === null) throw new Error('details section missing')
    expect(details).toHaveFocus()
    expect(within(details).getByText('sha512:xL84LD46WmZUGGWdU2Rf6i/oDtMMdwiJ3k3I5bkku51khl7cS88SLKfkUFNa9478GtHjT46wTqTyly7aoNmneQ==')).toBeVisible()
    expect(within(details).getByRole('link', { name: 'MIT · Publisher-declared' })).toBeVisible()
    expect(within(details).getByText(/Allowed filesystem roots/)).toBeVisible()
    expect(within(details).getByText('The dynamic MCP owner applies and verifies the connection in the current Host.')).toBeVisible()
    expect(within(details).getByText('Install availability · Unavailable · unavailable(host-capability)')).toBeVisible()
    expect(within(details).getByText('Configure availability · Unavailable · unavailable(host-capability)')).toBeVisible()
    expect(within(details).getByText('Update availability · Unavailable · unavailable(host-capability)')).toBeVisible()
    expect(within(details).getByText('Uninstall availability · Unavailable · unavailable(host-capability)')).toBeVisible()
    expect(within(details).getByText('Restore availability · Unavailable · unavailable(host-capability)')).toBeVisible()
    fireEvent.click(within(details).getByRole('button', { name: 'Close details' }))
    expect(detailTrigger).toHaveFocus()

    const resolver = within(storePanel).getByRole('heading', { name: 'DSH Capability Resolver' }).closest('article')
    if (resolver === null) throw new Error('Resolver card missing')
    fireEvent.click(within(resolver).getByRole('button', { name: 'View details' }))
    const resolverDetails = within(storePanel).getByRole('heading', { level: 3, name: 'DSH Capability Resolver' }).closest('section')
    if (resolverDetails === null) throw new Error('Resolver details missing')
    expect(within(resolverDetails).getByRole('heading', { name: 'Typed Configure fields' })).toBeVisible()
    for (const field of [
      'freshCacheMs', 'staleCacheMs', 'fetchTimeoutMs', 'maxCatalogBytes', 'maxCatalogEntries',
      'maxTaskChars', 'maxResults', 'maxCurrentMatches', 'maxMatchedTerms', 'maxDescriptionChars',
    ]) expect(within(resolverDetails).getByText(field)).toBeVisible()
    fireEvent.click(within(resolverDetails).getByRole('button', { name: 'Close details' }))

    expect(within(storePanel).getAllByRole('button', { name: 'Acquire unavailable' })).toHaveLength(3)
    expect(within(storePanel).getByText('unavailable(host-capability)')).toBeVisible()
    for (const label of ['Install', 'Configure', 'Update', 'Uninstall', 'Restore']) {
      const action = within(dialog).getByRole('button', { name: label })
      expect(action).toBeDisabled()
      expect(action).toHaveAttribute('title', 'unavailable(host-capability)')
    }
  })

  it('renders the verified Store with the registered Chinese dictionary', async () => {
    renderCenter(zh)
    fireEvent.click(screen.getByRole('button', { name: '扩展' }))
    const dialog = screen.getByRole('dialog', { name: '扩展商店' })
    expect(within(dialog).getByRole('tab', { name: '商店' })).toHaveAttribute('aria-selected', 'true')
    expect(within(dialog).getByText('只读目录预览')).toBeVisible()
    expect(await within(dialog).findByText('签名目录已验证')).toBeVisible()
    expect(within(dialog).getByRole('heading', { name: '文件系统 MCP' })).toBeVisible()
  })
})
