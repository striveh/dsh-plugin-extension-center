import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { cssText, styleTagId } from './ExtensionCenter.module.css'
import {
  bindExtensionCenterOverlay, EXTENSION_CENTER_LOCALE, ExtensionCenterOverlay, ExtensionCenterTrigger,
} from './ExtensionCenter.tsx'
import { createExtensionCatalogClient } from './catalog-api.ts'
import { en, zh } from './locales.ts'
import { createExtensionManagementClient } from './management-api.ts'
import { createExtensionCenterStore } from './store.ts'

/** Required browser services. */
export const inject = ['connection', 'slots', 'locale']

/** Register bilingual copy, effect-owned styles, and the two additive shell entries. */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(EXTENSION_CENTER_LOCALE, { zh, en }),
    'extension-center: dictionaries',
  )
  ctx.effect(() => {
    const existing = document.querySelector(`style[data-plugin-css="${styleTagId}"]`)
    if (existing !== null) throw new Error(`extension-center style already installed: ${styleTagId}`)
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-plugin-extension-center'
    style.dataset.pluginCss = styleTagId
    style.textContent = cssText
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'extension-center: styles')

  const store = createExtensionCenterStore()
  const connection = ctx.get('connection') as ConnectionHandle
  const BoundExtensionCenterOverlay = bindExtensionCenterOverlay(
    createExtensionCatalogClient(connection.rpc),
    createExtensionManagementClient(connection.rpc),
    { profileId: 'web', defaultScopeKey: 'profile:web' },
  )
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.inject('shell.overlay', () => [
      ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'extension-center',
        order: 0,
        locale: EXTENSION_CENTER_LOCALE,
        store,
      }, ExtensionCenterTrigger),
      ctx.slots.register({
        name: 'shell.overlay',
        id: 'extension-center',
        order: 0,
        locale: EXTENSION_CENTER_LOCALE,
        store,
      }, BoundExtensionCenterOverlay),
    ]))
}

export { ExtensionCenterOverlay, ExtensionCenterTrigger } from './ExtensionCenter.tsx'
export { createExtensionCatalogClient, parseCatalogListResponse } from './catalog-api.ts'
export {
  createExtensionManagementClient,
  parseConfigurationDraft,
  parseIntentPreviewResponse,
  parseInventoryListResponse,
  parseOperationListResponse,
  parseOperationReceiptsResponse,
} from './management-api.ts'
export { createExtensionCenterStore } from './store.ts'
