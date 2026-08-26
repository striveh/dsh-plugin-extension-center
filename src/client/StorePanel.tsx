import { useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogEntry, CatalogHostCapabilities, CatalogListResponse, ExtensionKind, LocalizedText } from '../catalog-contract.ts'
import type { RpcJson } from '../service/rpc-contract.ts'
import type { ExtensionCatalogClient } from './catalog-api.ts'
import type { ExtensionCenterKey } from './locales.ts'
import { MutationFlow } from './ManagementPanels.tsx'
import { HostCapabilityStatus } from './HostCapabilityStatus.tsx'
import type { ExtensionManagementClient, ExtensionManagementContext } from './management-api.ts'
import {
  RESOLVER_CANDIDATE_REF, ResolverConfigDisclosure,
} from './ResolverConfigDraft.tsx'
import { McpConfigurationDraft, SkillConfigurationDraft } from './TypedConfigurationDrafts.tsx'
import css from './ExtensionCenter.module.css'

type Translate = (key: ExtensionCenterKey) => string
type KindFilter = 'all' | ExtensionKind
type ScopeFilter = 'all' | CatalogEntry['scopes'][number]
type ConfigurationFilter = 'all' | 'ready' | 'required'
type PermissionFilter = 'all' | CatalogEntry['permissions'][number]['kind']
type LifecycleFilter = 'all' | 'complete' | 'blocked'
type LifecycleActionName = keyof CatalogEntry['lifecycle']

const LIFECYCLE_ACTIONS = [
  ['install', 'field.lifecycle.install'],
  ['configure', 'field.lifecycle.configure'],
  ['update', 'field.lifecycle.update'],
  ['uninstall', 'field.lifecycle.uninstall'],
  ['restore', 'field.lifecycle.restore'],
] as const satisfies readonly (readonly [LifecycleActionName, ExtensionCenterKey])[]

/** Store props kept outside the slot contract and captured by the registered wrapper. */
export interface StorePanelProps {
  readonly catalog: ExtensionCatalogClient
  readonly management?: ExtensionManagementClient
  readonly context: ExtensionManagementContext
  readonly t: Translate
}

function localize(value: LocalizedText, language: 'en' | 'zh'): string {
  return value[language]
}

function lifecycleComplete(entry: CatalogEntry): boolean {
  return Object.values(entry.lifecycle).every(action => action.status === 'available')
}

function writableScope(entry: CatalogEntry, scope: string): boolean {
  return entry.scopes.includes(scope as CatalogEntry['scopes'][number])
    && !(entry.kind === 'skill' && scope === 'project')
}

function scopeOption(entry: CatalogEntry, scope: CatalogEntry['scopes'][number], t: Translate): string {
  if (entry.kind === 'skill' && scope === 'project') return t('scope.projectUnavailable')
  return t(`scope.${scope === 'profile:web' ? 'profile' : scope}` as ExtensionCenterKey)
}

function licenseLabel(entry: CatalogEntry, t: Translate): string {
  const status = entry.license.status === 'publisher-declared' ? 'declared' : entry.license.status
  return `${entry.license.spdx ?? t('license.unknown')} · ${t(`license.${status}` as ExtensionCenterKey)}`
}

function admissionLabel(entry: CatalogEntry, t: Translate): string {
  const status = entry.publisher.status === 'upstream-registry' ? 'registry' : 'community'
  return t(`publisher.${status}` as ExtensionCenterKey)
}

function permissionLabel(entry: CatalogEntry, phase: 'acquisition' | 'runtime', language: 'en' | 'zh', t: Translate): string {
  const labels = entry.permissions
    .filter(permission => permission.phase === phase && permission.access !== 'none')
    .map((permission) => {
      const kind = permission.kind === 'model-context' ? 'model' : permission.kind
      return `${t(`permission.${kind}` as ExtensionCenterKey)} (${permission.access}): ${localize(permission.detail, language)}`
    })
  return [...new Set(labels)].join(', ') || t('field.none')
}

function verificationLabel(entry: CatalogEntry, language: 'en' | 'zh', t: Translate): string {
  return entry.verification.map((claim) =>
    `${localize(claim.claim, language)} · ${t(`verification.${claim.status}` as ExtensionCenterKey)}: ${localize(claim.detail, language)}`,
  ).join('; ') || t('field.notDeclared')
}

function sourceLabel(entry: CatalogEntry): string {
  return `${entry.source.label} · ${entry.source.type} · ${entry.source.upstreamUrl} · ${entry.source.admittedAt}`
}

function artifactLabel(entry: CatalogEntry): string {
  return `${entry.artifact.id}@${entry.artifact.version} · ${entry.artifact.sizeBytes} bytes · ${entry.artifact.acquisitionUrl}`
}

function compatibilityLabel(entry: CatalogEntry, language: 'en' | 'zh', t: Translate): string {
  const status = entry.compatibility.status === 'compatible'
    ? t('compatibility.compatible')
    : t('compatibility.review')
  return `${status} · DSH ${entry.compatibility.dsh} · ${entry.compatibility.platforms.join('/')} · ${localize(entry.compatibility.detail, language)}`
}

function dependencyLabel(entry: CatalogEntry, t: Translate): string {
  return entry.dependencies.map(dependency => {
    const requirement = dependency.required ? t('dependency.required') : t('dependency.optional')
    return `${t(`dependency.${dependency.kind}` as ExtensionCenterKey)} · ${dependency.id} ${dependency.version} · ${requirement}`
  }).join('; ') || t('field.notDeclared')
}

function configurationLabel(entry: CatalogEntry, language: 'en' | 'zh', t: Translate): string {
  const requirement = entry.configuration.required ? t('configuration.required') : t('configuration.ready')
  const credentials = t(`credentials.${entry.configuration.credentials}` as ExtensionCenterKey)
  const fields = entry.configuration.fields.map(field => localize(field, language)).join('; ') || t('field.notDeclared')
  return `${requirement} · ${t('field.credentials')}: ${credentials} · ${fields}`
}

function lifecycleActionLabel(
  entry: CatalogEntry,
  action: LifecycleActionName,
  t: Translate,
  unavailableReason?: string,
): string {
  if (unavailableReason !== undefined) return `${t('lifecycle.unavailable')} · ${unavailableReason}`
  const availability = entry.lifecycle[action]
  const status = t(`lifecycle.${availability.status}` as ExtensionCenterKey)
  if (availability.reason === undefined) {
    return availability.status === 'available' ? status : `${status} · ${t('field.notDeclared')}`
  }
  return `${status} · ${availability.status}(${availability.reason})`
}

function revealRegion(id: string): void {
  const region = document.getElementById(id)
  region?.focus()
  region?.scrollIntoView?.({ block: 'start' })
}

function visibleEntries(
  snapshot: CatalogListResponse,
  language: 'en' | 'zh',
  query: string,
  kind: KindFilter,
  scope: ScopeFilter,
  configuration: ConfigurationFilter,
  permission: PermissionFilter,
  lifecycle: LifecycleFilter,
  writable: boolean,
  mcpAvailability: Readonly<Record<string, 'loading' | 'ready' | 'missing' | 'error'>>,
): CatalogEntry[] {
  const needle = query.trim().toLocaleLowerCase(language === 'zh' ? 'zh-CN' : 'en-US')
  return snapshot.entries.filter((entry) => {
    const lifecycleAvailable = writable
      && (entry.kind !== 'mcp' || mcpAvailability[entry.candidateRef] === 'ready')
      && lifecycleComplete(entry)
    if (kind !== 'all' && entry.kind !== kind) return false
    if (scope !== 'all' && !entry.scopes.includes(scope)) return false
    if (configuration === 'ready' && entry.configuration.required) return false
    if (configuration === 'required' && !entry.configuration.required) return false
    if (permission !== 'all' && !entry.permissions.some(item => item.kind === permission && item.access !== 'none')) return false
    if (lifecycle === 'complete' && !lifecycleAvailable) return false
    if (lifecycle === 'blocked' && lifecycleAvailable) return false
    if (needle === '') return true
    const searchable = [
      entry.name,
      entry.displayName.en,
      entry.displayName.zh,
      entry.summary.en,
      entry.summary.zh,
      entry.publisher.name,
      entry.kind,
      ...entry.tags,
    ].join('\n').toLocaleLowerCase(language === 'zh' ? 'zh-CN' : 'en-US')
    return searchable.includes(needle)
  }).sort((left, right) => {
    const name = localize(left.displayName, language).localeCompare(
      localize(right.displayName, language),
      language === 'zh' ? 'zh-CN' : 'en-US',
    )
    return name === 0 ? left.candidateRef.localeCompare(right.candidateRef) : name
  })
}

/** Signed offline Store with local search, filters, details, and bounded comparison. */
export function StorePanel({ catalog, management, context, t }: StorePanelProps) {
  const language: 'en' | 'zh' = t('locale.code') === 'zh' ? 'zh' : 'en'
  const [snapshot, setSnapshot] = useState<CatalogListResponse>()
  const [error, setError] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [configuration, setConfiguration] = useState<ConfigurationFilter>('all')
  const [permission, setPermission] = useState<PermissionFilter>('all')
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>('all')
  const [detailRef, setDetailRef] = useState<string>()
  const [compareRefs, setCompareRefs] = useState<readonly string[]>([])
  const [comparisonOpen, setComparisonOpen] = useState(false)
  const [managementAttempt, setManagementAttempt] = useState(0)
  const [managementState, setManagementState] = useState<{
    readonly status: 'unavailable' | 'loading' | 'ready' | 'error'
    readonly acquisition?: boolean
    readonly capabilities?: Awaited<ReturnType<ExtensionManagementClient['inventory']>>['hostCapabilities']
    readonly error?: string
  }>({ status: management === undefined ? 'unavailable' : 'loading' })
  const [selectedScopes, setSelectedScopes] = useState<Readonly<Record<string, string>>>({})
  const [mcpAvailability, setMcpAvailability] = useState<Readonly<Record<string, 'loading' | 'ready' | 'missing' | 'error'>>>({})
  const [mutation, setMutation] = useState<{
    readonly id: string
    readonly candidate: CatalogEntry
    readonly candidateRef: string
    readonly operationKind: LifecycleActionName
    readonly scopeKey: string
    readonly profileId: string
    readonly targetKey: null
    readonly configuration: RpcJson
    readonly returnFocus: HTMLButtonElement
  }>()
  const [typedDraft, setTypedDraft] = useState<Readonly<{
    entry: CatalogEntry
    operationKind: LifecycleActionName
    scopeKey: string
    returnFocus: HTMLButtonElement
    status: 'loading' | 'ready' | 'error'
    options: Awaited<ReturnType<ExtensionManagementClient['configurationOptions']>>['options']
    currentConfiguration: RpcJson | null
    error?: string
  }>>()
  const configurationRequest = useRef<AbortController>()
  const catalogRefreshRequest = useRef<AbortController>()
  const comparisonTrigger = useRef<HTMLButtonElement>(null)
  const detailTrigger = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(undefined)
    setError(undefined)
    catalog.list(controller.signal).then(setSnapshot).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { controller.abort() }
  }, [attempt, catalog])

  useEffect(() => {
    if (management === undefined) {
      setManagementState({ status: 'unavailable' })
      return
    }
    const controller = new AbortController()
    setManagementState({ status: 'loading' })
    management.inventory(context.defaultScopeKey, context.profileId, controller.signal).then((response) => {
      setManagementState({
        status: 'ready',
        acquisition: response.hostCapabilities.acquisition,
        capabilities: response.hostCapabilities,
      })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setManagementState({ status: 'error', error: cause instanceof Error ? cause.message : String(cause) })
      }
    })
    return () => { controller.abort() }
  }, [context.defaultScopeKey, context.profileId, management, managementAttempt])

  useEffect(() => () => {
    configurationRequest.current?.abort()
    catalogRefreshRequest.current?.abort()
  }, [])

  useEffect(() => {
    if (management === undefined || snapshot === undefined || managementState.status !== 'ready') return
    const controller = new AbortController()
    const entries = snapshot.entries.filter(entry => entry.kind === 'mcp')
    setMcpAvailability(Object.fromEntries(entries.map(entry => [entry.candidateRef, 'loading'])))
    for (const entry of entries) {
      const scopeKey = entry.scopes[0]
      if (scopeKey === undefined) continue
      void management.configurationOptions({
        candidateRef: entry.candidateRef,
        targetKey: null,
        scopeKey,
        profileId: context.profileId,
      }, controller.signal).then((response) => {
        if (!controller.signal.aborted) setMcpAvailability(current => ({
          ...current,
          [entry.candidateRef]: response.options.length === 0 ? 'missing' : 'ready',
        }))
      }).catch(() => {
        if (!controller.signal.aborted) setMcpAvailability(current => ({ ...current, [entry.candidateRef]: 'error' }))
      })
    }
    return () => { controller.abort() }
  }, [context.profileId, management, managementState.status, snapshot])

  useEffect(() => {
    if (detailRef !== undefined) revealRegion('extension-center-detail')
  }, [detailRef])

  useEffect(() => {
    if (comparisonOpen && compareRefs.length >= 2) revealRegion('extension-center-comparison')
  }, [compareRefs.length, comparisonOpen])

  const writable = snapshot !== undefined
    && snapshot.hostCapabilities.acquisition
    && managementState.status === 'ready'
    && managementState.acquisition === true
  const results = useMemo(() => snapshot === undefined ? [] : visibleEntries(
    snapshot, language, query, kind, scope, configuration, permission, lifecycle, writable, mcpAvailability,
  ), [configuration, kind, language, lifecycle, mcpAvailability, permission, query, scope, snapshot, writable])
  const byRef = useMemo(
    () => new Map(snapshot?.entries.map(entry => [entry.candidateRef, entry]) ?? []),
    [snapshot],
  )
  const detail = detailRef === undefined ? undefined : byRef.get(detailRef)
  const compared = compareRefs.flatMap(ref => {
    const entry = byRef.get(ref)
    return entry === undefined ? [] : [entry]
  })
  const unavailableReason = (entry: CatalogEntry): string | undefined => !writable
    ? t('lifecycle.code')
    : entry.kind === 'mcp' && mcpAvailability[entry.candidateRef] !== 'ready'
      ? t('mcpConfig.runtimeMissing')
      : undefined

  const launchStoreMutation = (
    entry: CatalogEntry,
    operationKind: LifecycleActionName,
    configuration: RpcJson,
    returnFocus: HTMLButtonElement,
  ): void => {
    const selectedScope = selectedScopes[entry.candidateRef]
    if (!writable || selectedScope === undefined || !writableScope(entry, selectedScope)) return
    if (entry.lifecycle[operationKind].status !== 'available') return
    setMutation({
      id: `${entry.candidateRef}:${operationKind}:${selectedScope}:${String(Date.now())}`,
      candidate: entry,
      candidateRef: entry.candidateRef,
      operationKind,
      scopeKey: selectedScope,
      profileId: context.profileId,
      targetKey: null,
      configuration,
      returnFocus,
    })
  }

  const openTypedDraft = (
    entry: CatalogEntry,
    operationKind: LifecycleActionName,
    returnFocus: HTMLButtonElement,
  ): void => {
    const selectedScope = selectedScopes[entry.candidateRef]
    if (management === undefined || selectedScope === undefined || !writableScope(entry, selectedScope)) return
    configurationRequest.current?.abort()
    const controller = new AbortController()
    configurationRequest.current = controller
    setTypedDraft({
      entry, operationKind, scopeKey: selectedScope, returnFocus, status: 'loading', options: [], currentConfiguration: null,
    })
    management.configurationOptions({
      candidateRef: entry.candidateRef,
      targetKey: null,
      scopeKey: selectedScope,
      profileId: context.profileId,
    }, controller.signal).then((response) => {
      if (!controller.signal.aborted) setTypedDraft({
        entry, operationKind, scopeKey: selectedScope, returnFocus, status: 'ready',
        options: response.options, currentConfiguration: response.currentConfiguration,
      })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setTypedDraft({
        entry, operationKind, scopeKey: selectedScope, returnFocus, status: 'error', options: [], currentConfiguration: null,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    })
  }

  const toggleCompare = (candidateRef: string): void => {
    setCompareRefs((current) => current.includes(candidateRef)
      ? current.filter(ref => ref !== candidateRef)
      : current.length >= 3 ? current : [...current, candidateRef])
  }

  if (error !== undefined) {
    return (
      <section className={css.discoveryError} role="alert">
        <strong>{t('catalog.unavailable')}</strong>
        <p>{t('catalog.unavailable.body')}</p>
        <code>{error}</code>
        <button type="button" onClick={() => { setAttempt(value => value + 1) }}>{t('catalog.retry')}</button>
      </section>
    )
  }
  if (snapshot === undefined) return <div className={css.catalogLoading} role="status">{t('catalog.loading')}</div>

  return (
    <div className={css.store}>
      <section
        className={css.catalogStatus}
        aria-label={t('catalog.status')}
        data-catalog-revision={snapshot.catalog.revision}
        data-catalog-signature={snapshot.catalog.signatureStatus}
        data-catalog-source={snapshot.catalog.source}
        data-catalog-freshness={snapshot.catalog.freshness}
        data-catalog-degraded={String(snapshot.catalog.degraded)}
      >
        <div>
          <strong>{t('catalog.verified')}</strong>
          <span>{t('catalog.revision')} {snapshot.catalog.revision}</span>
          <span>{snapshot.entries.length} {t('catalog.candidates')}</span>
          <span>{t('catalog.source')}: {snapshot.catalog.source}</span>
          <span>{t('catalog.freshness')}: {snapshot.catalog.freshness}</span>
        </div>
        <code data-catalog-digest={snapshot.catalog.entriesDigest} title={snapshot.catalog.entriesDigest}>{snapshot.catalog.entriesDigest.slice(0, 22)}…</code>
        {snapshot.catalog.lastRefreshAtMs === null ? null : (
          <span>{t('catalog.lastRefresh')}: {new Date(snapshot.catalog.lastRefreshAtMs).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</span>
        )}
        {snapshot.catalog.degraded ? (
          <p role="status"><strong>{t('catalog.degraded')}</strong>: {snapshot.catalog.degradedReason}</p>
        ) : null}
        <p>{t('catalog.offline')}</p>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => {
            if (catalog.refresh === undefined) {
              setAttempt(value => value + 1)
              return
            }
            catalogRefreshRequest.current?.abort()
            const controller = new AbortController()
            catalogRefreshRequest.current = controller
            setRefreshing(true)
            setError(undefined)
            void catalog.refresh(controller.signal).then((value) => {
              if (!controller.signal.aborted) setSnapshot(value)
            }).catch((cause: unknown) => {
              if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
            }).finally(() => {
              if (!controller.signal.aborted) setRefreshing(false)
            })
          }}
        >
          {refreshing ? t('catalog.loading') : t('catalog.refresh')}
        </button>
      </section>

      <section className={css.discoveryControls} aria-labelledby="extension-center-discovery-heading">
        <div className={css.discoveryHeading}>
          <div>
            <h3 id="extension-center-discovery-heading">{t('store.heading')}</h3>
            <p>{t('store.body')}</p>
          </div>
          <button
            ref={comparisonTrigger}
            type="button"
            disabled={compareRefs.length < 2}
            aria-expanded={comparisonOpen && compared.length >= 2}
            aria-controls="extension-center-comparison"
            onClick={() => {
              setDetailRef(undefined)
              setComparisonOpen(true)
            }}
          >
            {t('compare.open')} ({compareRefs.length}/3)
          </button>
        </div>
        <label className={css.search}>
          <span>{t('search.label')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('search.placeholder')}
            onChange={(event) => { setQuery(event.currentTarget.value) }}
          />
        </label>
        <div className={css.filters}>
          <Filter label={t('filter.kind')} value={kind} onChange={value => { setKind(value as KindFilter) }} options={[
            ['all', t('filter.all')], ['plugin', t('kind.plugin')], ['mcp', t('kind.mcp')], ['skill', t('kind.skill')],
          ]} />
          <Filter label={t('filter.scope')} value={scope} onChange={value => { setScope(value as ScopeFilter) }} options={[
            ['all', t('filter.all')], ['profile:web', t('scope.profile')], ['user', t('scope.user')], ['project', t('scope.project')],
          ]} />
          <Filter label={t('filter.configuration')} value={configuration} onChange={value => { setConfiguration(value as ConfigurationFilter) }} options={[
            ['all', t('filter.all')], ['ready', t('configuration.ready')], ['required', t('configuration.required')],
          ]} />
          <Filter label={t('filter.permission')} value={permission} onChange={value => { setPermission(value as PermissionFilter) }} options={[
            ['all', t('filter.all')], ['network', t('permission.network')], ['filesystem', t('permission.filesystem')],
            ['subprocess', t('permission.subprocess')], ['credentials', t('permission.credentials')], ['model-context', t('permission.model')],
          ]} />
          <Filter label={t('filter.lifecycle')} value={lifecycle} onChange={value => { setLifecycle(value as LifecycleFilter) }} options={[
            ['all', t('filter.all')], ['complete', t('lifecycle.complete')], ['blocked', t('lifecycle.blocked')],
          ]} />
        </div>
      </section>

      <div className={css.resultSummary} role="status">
        {t('results.showing')} {results.length} / {snapshot.entries.length}
      </div>
      {results.length === 0 ? (
        <div className={css.empty}><h3>{t('results.empty')}</h3><p>{t('results.empty.body')}</p></div>
      ) : (
        <div className={css.candidateGrid} aria-label={t('results.label')}>
          {results.map(entry => (
            <CandidateCard
              key={entry.candidateRef}
              entry={entry}
              language={language}
              detailOpen={detailRef === entry.candidateRef}
              selected={compareRefs.includes(entry.candidateRef)}
              compareDisabled={compareRefs.length >= 3 && !compareRefs.includes(entry.candidateRef)}
              selectedScope={selectedScopes[entry.candidateRef] ?? ''}
              writable={writable && (entry.kind !== 'mcp' || mcpAvailability[entry.candidateRef] === 'ready')}
              acquisitionReason={unavailableReason(entry)}
              t={t}
              onDetails={(origin) => {
                detailTrigger.current = origin
                setDetailRef(entry.candidateRef)
                setComparisonOpen(false)
              }}
              onCompare={() => { toggleCompare(entry.candidateRef) }}
              onScope={(selectedScope) => {
                setSelectedScopes(current => ({ ...current, [entry.candidateRef]: selectedScope }))
              }}
              onAcquire={(returnFocus) => {
                const selectedScope = selectedScopes[entry.candidateRef]
                if (selectedScope === undefined || selectedScope === '') return
                setDetailRef(undefined)
                setComparisonOpen(false)
                if (entry.kind === 'skill' || entry.kind === 'mcp') openTypedDraft(entry, 'install', returnFocus)
                else launchStoreMutation(entry, 'install', {}, returnFocus)
              }}
            />
          ))}
        </div>
      )}

      {detail === undefined ? null : (
        <CandidateDetail
          entry={detail}
          language={language}
          writable={writable && (detail.kind !== 'mcp' || mcpAvailability[detail.candidateRef] === 'ready')}
          unavailableReason={unavailableReason(detail)}
          selectedScope={selectedScopes[detail.candidateRef] ?? ''}
          t={t}
          onScope={(selectedScope) => {
            setSelectedScopes(current => ({ ...current, [detail.candidateRef]: selectedScope }))
          }}
          onLifecycle={(operationKind, configuration, returnFocus) => {
            if ((detail.kind === 'skill' || detail.kind === 'mcp')
              && (operationKind === 'install' || operationKind === 'configure')) {
              openTypedDraft(detail, operationKind, returnFocus)
            } else {
              launchStoreMutation(detail, operationKind, configuration, returnFocus)
            }
          }}
          onClose={() => {
            setDetailRef(undefined)
            detailTrigger.current?.focus()
          }}
        />
      )}
      {!comparisonOpen || compared.length < 2 ? null : (
        <Comparison entries={compared} language={language} t={t} unavailableReason={unavailableReason} onClose={() => {
          setComparisonOpen(false)
          comparisonTrigger.current?.focus()
        }} />
      )}

      {mutation === undefined || management === undefined ? null : (
        <MutationFlow
          key={mutation.id}
          request={mutation}
          candidate={mutation.candidate}
          management={management}
          t={t}
          onClose={() => {
            setMutation(undefined)
            setManagementAttempt(value => value + 1)
          }}
        />
      )}

      {typedDraft === undefined ? null : (
        <section className={css.planReview} aria-label={t('field.configuration')} tabIndex={-1}>
          {typedDraft.status === 'loading' ? <div role="status">{t('inventory.loading')}</div> : null}
          {typedDraft.status === 'error' ? (
            <div className={css.managementError} role="alert">
              <strong>{t('management.unavailable')}</strong><code>{typedDraft.error}</code>
              <button type="button" onClick={() => { setTypedDraft(undefined); typedDraft.returnFocus.focus() }}>{t('action.cancel')}</button>
            </div>
          ) : null}
          {typedDraft.status !== 'ready' ? null : typedDraft.entry.kind === 'mcp' ? (
            <McpConfigurationDraft
              options={typedDraft.options}
              initial={typedDraft.currentConfiguration}
              t={t}
              onSave={(value) => {
                const current = typedDraft
                setTypedDraft(undefined)
                launchStoreMutation(current.entry, current.operationKind, value, current.returnFocus)
              }}
              onDiscard={() => { setTypedDraft(undefined); typedDraft.returnFocus.focus() }}
            />
          ) : (
            <SkillConfigurationDraft
              scopeKey={typedDraft.scopeKey}
              initial={typedDraft.currentConfiguration}
              t={t}
              onSave={(value) => {
                const current = typedDraft
                setTypedDraft(undefined)
                launchStoreMutation(current.entry, current.operationKind, value, current.returnFocus)
              }}
              onDiscard={() => { setTypedDraft(undefined); typedDraft.returnFocus.focus() }}
            />
          )}
        </section>
      )}

      {snapshot.hostCapabilities.acquisition
        && managementState.status === 'ready'
        && managementState.acquisition === true ? null : (
        <LifecycleUnavailable
          t={t}
          capabilities={managementState.status === 'ready' && managementState.acquisition === false
            ? managementState.capabilities ?? snapshot.hostCapabilities
            : snapshot.hostCapabilities}
          error={managementState.error}
          retry={management === undefined ? undefined : () => { setManagementAttempt(value => value + 1) }}
        />
      )}
    </div>
  )
}

function Filter({ label, value, options, onChange }: {
  label: string
  value: string
  options: readonly (readonly [string, string])[]
  onChange: (value: string) => void
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => { onChange(event.currentTarget.value) }}>
        {options.map(([option, copy]) => <option key={option} value={option}>{copy}</option>)}
      </select>
    </label>
  )
}

function CandidateCard({
  entry, language, detailOpen, selected, compareDisabled, selectedScope, writable, t,
  acquisitionReason, onDetails, onCompare, onScope, onAcquire,
}: {
  entry: CatalogEntry
  language: 'en' | 'zh'
  detailOpen: boolean
  selected: boolean
  compareDisabled: boolean
  selectedScope: string
  writable: boolean
  acquisitionReason?: string
  t: Translate
  onDetails: (origin: HTMLButtonElement) => void
  onCompare: () => void
  onScope: (scope: string) => void
  onAcquire: (returnFocus: HTMLButtonElement) => void
}) {
  const permissions = [...new Set(entry.permissions.filter(item => item.access !== 'none').map(item => t(`permission.${item.kind === 'model-context' ? 'model' : item.kind}` as ExtensionCenterKey)))]
  const admitted = entry.lifecycle.install.status === 'available'
  const acquireAvailable = writable && admitted
  return (
    <article className={css.candidateCard} data-candidate-ref={entry.candidateRef}>
      <div className={css.cardMeta}>
        <span data-kind={entry.kind}>{t(`kind.${entry.kind}` as ExtensionCenterKey)}</span>
        <span>{entry.compatibility.status === 'compatible' ? t('compatibility.compatible') : t('compatibility.review')}</span>
      </div>
      <h4>{localize(entry.displayName, language)}</h4>
      <p>{localize(entry.summary, language)}</p>
      <dl className={css.cardFacts}>
        <div><dt>{t('field.publisher')}</dt><dd>{entry.publisher.name}</dd></div>
        <div><dt>{t('field.admission')}</dt><dd>{admissionLabel(entry, t)}</dd></div>
        <div><dt>{t('field.license')}</dt><dd>{licenseLabel(entry, t)}</dd></div>
        <div><dt>{t('field.version')}</dt><dd><code>{entry.artifact.version}</code></dd></div>
        <div><dt>{t('field.permissions')}</dt><dd>{permissions.join(', ') || t('field.none')}</dd></div>
        <div><dt>{t('field.configuration')}</dt><dd>{entry.configuration.required ? t('configuration.required') : t('configuration.ready')}</dd></div>
      </dl>
      <label className={css.candidateScope}>
        <span>{t('acquire.scope')}</span>
        <select value={selectedScope} disabled={!acquireAvailable} onChange={(event) => { onScope(event.currentTarget.value) }}>
          <option value="">{t('acquire.scope.placeholder')}</option>
          {entry.scopes.map(scope => (
            <option key={scope} value={scope} disabled={!writableScope(entry, scope)}>{scopeOption(entry, scope, t)}</option>
          ))}
        </select>
      </label>
      <div className={css.cardActions}>
        <button
          type="button"
          aria-expanded={detailOpen}
          aria-controls="extension-center-detail"
          onClick={(event) => { onDetails(event.currentTarget) }}
        >{t('details.open')}</button>
        <button type="button" aria-pressed={selected} disabled={compareDisabled} onClick={onCompare}>
          {selected ? t('compare.remove') : t('compare.add')}
        </button>
        <button
          type="button"
          disabled={!acquireAvailable || !writableScope(entry, selectedScope)}
          title={!acquireAvailable
            ? acquisitionReason ?? entry.lifecycle.install.reason ?? t('lifecycle.code')
            : !writableScope(entry, selectedScope) ? t('acquire.scope.required') : undefined}
          onClick={(event) => { onAcquire(event.currentTarget) }}
        >{!acquireAvailable ? t('acquire.unavailable') : entry.kind === 'mcp' ? t('acquire.reviewMcp') : t('acquire.review')}</button>
      </div>
    </article>
  )
}

function CandidateDetail({ entry, language, writable, unavailableReason, selectedScope, t, onScope, onLifecycle, onClose }: {
  entry: CatalogEntry
  language: 'en' | 'zh'
  writable: boolean
  unavailableReason?: string
  selectedScope: string
  t: Translate
  onScope: (scope: string) => void
  onLifecycle: (
    operationKind: LifecycleActionName,
    configuration: RpcJson,
    returnFocus: HTMLButtonElement,
  ) => void
  onClose: () => void
}) {
  return (
    <section id="extension-center-detail" className={css.detail} aria-labelledby="extension-center-detail-heading" tabIndex={-1}>
      <header>
        <div>
          <span>{t(`kind.${entry.kind}` as ExtensionCenterKey)}</span>
          <h3 id="extension-center-detail-heading">{localize(entry.displayName, language)}</h3>
        </div>
        <button type="button" onClick={onClose}>{t('details.close')}</button>
      </header>
      <section className={css.storeLifecycle} aria-labelledby="extension-center-detail-actions">
        <h4 id="extension-center-detail-actions">{t('field.lifecycle')}</h4>
        <label className={css.candidateScope}>
          <span>{t('acquire.scope')}</span>
          <select value={selectedScope} disabled={!writable} onChange={(event) => { onScope(event.currentTarget.value) }}>
            <option value="">{t('acquire.scope.placeholder')}</option>
            {entry.scopes.map(scope => (
              <option key={scope} value={scope} disabled={!writableScope(entry, scope)}>{scopeOption(entry, scope, t)}</option>
            ))}
          </select>
        </label>
        <p>{t('store.installOnly')}</p>
        <div className={css.lifecycleActions} aria-label={t('field.lifecycle')}>
          <button
            type="button"
            disabled={!writable || !writableScope(entry, selectedScope) || entry.lifecycle.install.status !== 'available'}
            title={!writable
              ? unavailableReason ?? t('lifecycle.code')
              : !writableScope(entry, selectedScope) ? t('acquire.scope.required') : lifecycleActionLabel(entry, 'install', t)}
            onClick={(event) => { onLifecycle('install', {}, event.currentTarget) }}
          >{entry.kind === 'mcp' ? t('acquire.reviewMcp') : t('action.install')}</button>
        </div>
      </section>
      <dl className={css.detailFacts}>
        <Fact label={t('field.publisher')}>{entry.publisher.name}</Fact>
        <Fact label={t('field.admission')}>{admissionLabel(entry, t)}</Fact>
        <Fact label={t('field.source')}><a href={entry.source.url} target="_blank" rel="noreferrer">{entry.source.label}</a></Fact>
        <Fact label={t('field.sourceType')}>{entry.source.type}</Fact>
        <Fact label={t('field.upstream')}><a href={entry.source.upstreamUrl} target="_blank" rel="noreferrer">{entry.source.upstreamUrl}</a></Fact>
        <Fact label={t('field.admittedAt')}>{entry.source.admittedAt}</Fact>
        <Fact label={t('field.license')}>
          {entry.license.sourceUrl === null
            ? licenseLabel(entry, t)
            : <a href={entry.license.sourceUrl} target="_blank" rel="noreferrer">{licenseLabel(entry, t)}</a>}
        </Fact>
        <Fact label={t('field.revision')}><code>{entry.source.revision}</code></Fact>
        <Fact label={t(entry.kind === 'mcp' ? 'field.catalogReference' : 'field.artifact')}><code>{entry.artifact.id}@{entry.artifact.version} · {entry.artifact.sizeBytes} bytes</code></Fact>
        <Fact label={t(entry.kind === 'mcp' ? 'field.catalogReferenceUrl' : 'field.acquisitionUrl')}><a href={entry.artifact.acquisitionUrl} target="_blank" rel="noreferrer">{entry.artifact.acquisitionUrl}</a></Fact>
        <Fact label={t(entry.kind === 'mcp' ? 'field.catalogReferenceIntegrity' : 'field.integrity')}><code>{entry.artifact.integrity}</code></Fact>
        {entry.kind === 'mcp' ? <Fact label={t('plan.externalRuntimeAction')}>{t('mcpConfig.noArtifactAcquisition')}</Fact> : null}
        <Fact label={t('field.components')}>{entry.components.map(item => localize(item, language)).join('; ') || t('field.notDeclared')}</Fact>
        <Fact label={t('field.compatibility')}>{compatibilityLabel(entry, language, t)}</Fact>
        <Fact label={t('field.dependencies')}>{dependencyLabel(entry, t)}</Fact>
        <Fact label={t('field.scopes')}>{entry.scopes.map(item => t(`scope.${item === 'profile:web' ? 'profile' : item}` as ExtensionCenterKey)).join(', ')}</Fact>
        <Fact label={t('field.configuration')}>{configurationLabel(entry, language, t)}</Fact>
        <Fact label={t('field.conflicts')}>{entry.conflicts.map(item => localize(item, language)).join('; ') || t('field.noneDeclared')}</Fact>
        <Fact label={t('field.restart')}>{localize(entry.restart.detail, language)}</Fact>
        <Fact label={t('field.retention')}>{localize(entry.retainedData, language)}</Fact>
      </dl>
      <section className={css.disclosure}>
        <h4>{t('field.lifecycle')}</h4>
        <ul>{LIFECYCLE_ACTIONS.map(([action, label]) => (
          <li key={action}>
            <strong>{t(label)} · {lifecycleActionLabel(entry, action, t, unavailableReason)}</strong>
          </li>
        ))}</ul>
      </section>
      {entry.candidateRef === RESOLVER_CANDIDATE_REF ? <ResolverConfigDisclosure t={t} /> : null}
      <section className={css.disclosure}>
        <h4>{t('field.permissions')}</h4>
        <ul>{entry.permissions.map((permission, index) => (
          <li key={`${permission.phase}-${permission.kind}-${index}`}>
            <strong>{t(`phase.${permission.phase}` as ExtensionCenterKey)} · {t(`permission.${permission.kind === 'model-context' ? 'model' : permission.kind}` as ExtensionCenterKey)} · {permission.access}</strong>
            <span>{localize(permission.detail, language)}</span>
          </li>
        ))}</ul>
      </section>
      <section className={css.disclosure}>
        <h4>{t('field.verification')}</h4>
        <ul>{entry.verification.map((claim, index) => (
          <li key={index}>
            <strong>{localize(claim.claim, language)} · {t(`verification.${claim.status}` as ExtensionCenterKey)}</strong>
            <span>{localize(claim.detail, language)}</span>
          </li>
        ))}</ul>
      </section>
    </section>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

function Comparison({ entries, language, t, unavailableReason, onClose }: {
  entries: readonly CatalogEntry[]
  language: 'en' | 'zh'
  t: Translate
  unavailableReason: (entry: CatalogEntry) => string | undefined
  onClose: () => void
}) {
  const rows: readonly (readonly [ExtensionCenterKey, (entry: CatalogEntry) => string])[] = [
    ['field.type', entry => t(`kind.${entry.kind}` as ExtensionCenterKey)],
    ['field.publisher', entry => entry.publisher.name],
    ['field.admission', entry => admissionLabel(entry, t)],
    ['field.license', entry => licenseLabel(entry, t)],
    ['field.version', entry => entry.artifact.version],
    ['field.revision', entry => entry.source.revision],
    ['field.artifact', entry => artifactLabel(entry)],
    ['field.integrity', entry => entry.artifact.integrity],
    ['field.source', entry => sourceLabel(entry)],
    ['field.components', entry => entry.components.map(component => localize(component, language)).join('; ') || t('field.notDeclared')],
    ['field.compatibility', entry => compatibilityLabel(entry, language, t)],
    ['field.dependencies', entry => dependencyLabel(entry, t)],
    ['field.scopes', entry => entry.scopes.map(scope => t(`scope.${scope === 'profile:web' ? 'profile' : scope}` as ExtensionCenterKey)).join(', ')],
    ['field.configuration', entry => configurationLabel(entry, language, t)],
    ['field.acquisitionAuthority', entry => permissionLabel(entry, 'acquisition', language, t)],
    ['field.runtimeAuthority', entry => permissionLabel(entry, 'runtime', language, t)],
    ['field.conflicts', entry => entry.conflicts.map(conflict => localize(conflict, language)).join('; ') || t('field.noneDeclared')],
    ['field.restart', entry => `${entry.restart.required ? t('restart.required') : t('restart.notRequired')} · ${localize(entry.restart.detail, language)}`],
    ...LIFECYCLE_ACTIONS.map(([action, label]) => [
      label,
      (entry: CatalogEntry) => lifecycleActionLabel(entry, action, t, unavailableReason(entry)),
    ] as const),
    ['field.verification', entry => verificationLabel(entry, language, t)],
    ['field.retention', entry => localize(entry.retainedData, language)],
  ]
  return (
    <section id="extension-center-comparison" className={css.comparison} aria-labelledby="extension-center-comparison-heading" tabIndex={-1}>
      <header>
        <h3 id="extension-center-comparison-heading">{t('compare.heading')}</h3>
        <button type="button" onClick={onClose}>{t('compare.close')}</button>
      </header>
      <div className={css.tableScroll}>
        <table>
          <thead><tr><th scope="col">{t('compare.field')}</th>{entries.map(entry => (
            <th key={entry.candidateRef} scope="col">{localize(entry.displayName, language)}</th>
          ))}</tr></thead>
          <tbody>{rows.map(([label, value]) => (
            <tr key={label}><th scope="row">{t(label)}</th>{entries.map(entry => (
              <td key={entry.candidateRef}>{value(entry)}</td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  )
}

function LifecycleUnavailable({ t, capabilities, error, retry }: {
  t: Translate
  capabilities: CatalogHostCapabilities
  error?: string
  retry?: () => void
}) {
  const actions = [
    'action.install', 'action.configure', 'action.update', 'action.uninstall', 'action.restore',
  ] as const satisfies readonly ExtensionCenterKey[]
  return (
    <section className={css.lifecycle} role="status">
      <div>
        <h3>{t('lifecycle.heading')}</h3>
        <p>{t('lifecycle.body')}</p>
        <code>{t('lifecycle.code')}</code>
        {error === undefined ? null : <code>{error}</code>}
        {retry === undefined ? null : <button type="button" onClick={retry}>{t('management.retry')}</button>}
      </div>
      <HostCapabilityStatus capabilities={capabilities} t={t} />
      <div className={css.actions} aria-label={t('lifecycle.heading')}>
        {actions.map(action => <button key={action} type="button" disabled title={t('lifecycle.code')}>{t(action)}</button>)}
      </div>
    </section>
  )
}
