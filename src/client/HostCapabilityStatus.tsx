import type { CatalogHostCapabilities } from '../catalog-contract.ts'
import type { ExtensionCenterKey } from './locales.ts'
import css from './ExtensionCenter.module.css'

type Translate = (key: ExtensionCenterKey) => string

type HostCapabilityEvidence = Pick<
  CatalogHostCapabilities,
  | 'profileTransaction'
  | 'dynamicMcpConnection'
  | 'durableContinuation'
  | 'skillRegistry'
  | 'toolRegistry'
  | 'loaderObservation'
>

const HOST_CAPABILITIES = [
  ['profileTransaction', 'capability.profileTransaction'],
  ['dynamicMcpConnection', 'capability.dynamicMcpConnection'],
  ['durableContinuation', 'capability.durableContinuation'],
  ['skillRegistry', 'capability.skillRegistry'],
  ['toolRegistry', 'capability.toolRegistry'],
  ['loaderObservation', 'capability.loaderObservation'],
] as const satisfies readonly (readonly [keyof HostCapabilityEvidence, ExtensionCenterKey])[]

/** Render every independent writable-Host preflight fact. */
export function HostCapabilityStatus({ capabilities, t }: {
  readonly capabilities: HostCapabilityEvidence
  readonly t: Translate
}) {
  return (
    <dl className={css.capabilityGrid} aria-label={t('capability.heading')}>
      {HOST_CAPABILITIES.map(([key, label]) => (
        <div key={key}>
          <dt>{t(label)}</dt>
          <dd data-capability-status={capabilities[key] ? 'ready' : 'missing'}>
            {capabilities[key] ? t('capability.ready') : t('capability.missing')}
          </dd>
        </div>
      ))}
    </dl>
  )
}
