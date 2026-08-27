import { useEffect, useRef, useState } from 'react'
import type { CatalogEntry } from '../catalog-contract.ts'
import type { InventoryRow } from '../inventory/types.ts'
import type { OperationKind } from '../plans/types.ts'
import type { HostCapabilityProjection, RpcJson } from '../service/rpc-contract.ts'
import type { TaskConfigurationRow } from '../service/rpc-contract.ts'
import type { TaskRetryContinuationProjectionState } from '../task-attempt/index.ts'
import { isCapabilityResolverCandidate } from '../resolver-candidates.ts'
import { HostCapabilityStatus } from './HostCapabilityStatus.tsx'
import type { ExtensionCenterKey } from './locales.ts'
import type { ExtensionManagementClient, ExtensionManagementContext } from './management-api.ts'
import { PlanReview, ReviewEvidenceDetails } from './PlanReview.tsx'
import { ResolverConfigDraft } from './ResolverConfigDraft.tsx'
import { McpConfigurationDraft, SkillConfigurationDraft } from './TypedConfigurationDrafts.tsx'
import css from './ExtensionCenter.module.css'

type Translate = (key: ExtensionCenterKey) => string

const ACTIONS = [
  'install', 'configure', 'update', 'enable', 'disable', 'uninstall', 'restore', 'purge',
] as const satisfies readonly OperationKind[]

const RETRY_CONTINUATION_KEYS: Readonly<Record<TaskRetryContinuationProjectionState, ExtensionCenterKey>> = {
  pending: 'taskAttempt.retryContinuation.pending',
  ready: 'taskAttempt.retryContinuation.ready',
  consumed: 'taskAttempt.retryContinuation.consumed',
  dispatching: 'taskAttempt.retryContinuation.dispatching',
  dispatched: 'taskAttempt.retryContinuation.dispatched',
  claimed: 'taskAttempt.retryContinuation.claimed',
  'delivery-unknown': 'taskAttempt.retryContinuation.deliveryUnknown',
  canceled: 'taskAttempt.retryContinuation.canceled',
  superseded: 'taskAttempt.retryContinuation.superseded',
  expired: 'taskAttempt.retryContinuation.expired',
  invalid: 'taskAttempt.retryContinuation.invalid',
  reconciling: 'taskAttempt.retryContinuation.reconciling',
  unavailable: 'taskAttempt.retryContinuation.unavailable',
}

const CANCELABLE_RETRY_CONTINUATION_STATES = new Set<TaskRetryContinuationProjectionState>([
  'pending', 'ready', 'consumed', 'reconciling',
])

interface MutationRequest {
  readonly id: string
  readonly candidateRef: string
  readonly operationKind: OperationKind
  readonly scopeKey: string
  readonly profileId: string
  readonly targetKey: string | null
  readonly configuration: RpcJson
  readonly returnFocus?: HTMLElement
}

interface ManagementPanelProps {
  readonly management?: ExtensionManagementClient
  readonly context: ExtensionManagementContext
  readonly candidates: ReadonlyMap<string, CatalogEntry>
  readonly t: Translate
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function useInventory(
  management: ExtensionManagementClient | undefined,
  context: ExtensionManagementContext,
  scopeKey: string,
  attempt: number,
) {
  const [state, setState] = useState<{
    readonly status: 'unavailable' | 'loading' | 'ready' | 'error'
    readonly value?: Awaited<ReturnType<ExtensionManagementClient['inventory']>>
    readonly error?: string
  }>({ status: management === undefined ? 'unavailable' : 'loading' })

  useEffect(() => {
    if (management === undefined) {
      setState({ status: 'unavailable' })
      return
    }
    const controller = new AbortController()
    setState({ status: 'loading' })
    management.inventory(scopeKey, context.profileId, controller.signal).then((value) => {
      setState({ status: 'ready', value })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setState({ status: 'error', error: message(cause) })
    })
    return () => { controller.abort() }
  }, [attempt, context.profileId, management, scopeKey])

  return state
}

function ManagementScopePicker({ value, t, onChange }: {
  readonly value: string
  readonly t: Translate
  readonly onChange: (scopeKey: string) => void
}) {
  return (
    <label>
      <span>{t('filter.scope')}</span>
      <select value={value} onChange={(event) => { onChange(event.currentTarget.value) }}>
        <option value="profile:web">{t('scope.profile')}</option>
        <option value="user">{t('scope.user')}</option>
        <option value="project">{t('scope.project')}</option>
      </select>
    </label>
  )
}

/** Preview one exact mutation before exposing the separate human decision. */
export function MutationFlow({ request: input, candidate, management, t, onClose, onCommitted }: {
  readonly request: MutationRequest
  readonly candidate?: CatalogEntry
  readonly management: ExtensionManagementClient
  readonly t: Translate
  readonly onClose: () => void
  readonly onCommitted?: () => void
}) {
  const returnFocus = useRef<HTMLElement | null>(
    input.returnFocus ?? (typeof document === 'undefined' || !(document.activeElement instanceof HTMLElement)
      ? null
      : document.activeElement),
  )
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    readonly status: 'loading' | 'ready' | 'error'
    readonly preview?: Awaited<ReturnType<ExtensionManagementClient['preview']>>
    readonly error?: string
  }>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    management.preview({
      candidateRef: input.candidateRef,
      operationKind: input.operationKind,
      scopeKey: input.scopeKey,
      profileId: input.profileId,
      targetKey: input.targetKey,
      configuration: input.configuration,
    }, controller.signal).then((preview) => {
      setState({ status: 'ready', preview })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setState({ status: 'error', error: message(cause) })
    })
    return () => { controller.abort() }
  }, [attempt, input, management])

  useEffect(() => () => { returnFocus.current?.focus() }, [])

  if (state.status === 'loading') return <div className={css.managementLoading} role="status">{t('plan.loading')}</div>
  if (state.status === 'error') {
    return (
      <div className={css.managementError} role="alert">
        <strong>{t('plan.unavailable')}</strong>
        <p>{t('plan.unavailable.body')}</p>
        <code>{state.error}</code>
        <div className={css.inlineActions}>
          <button type="button" onClick={() => { setAttempt(value => value + 1) }}>{t('action.retry')}</button>
          <button type="button" onClick={onClose}>{t('action.cancel')}</button>
        </div>
      </div>
    )
  }
  return (
    <PlanReview
      preview={state.preview!}
      candidate={candidate}
      management={management}
      configuration={input.configuration}
      t={t}
      onClose={onClose}
      onCommitted={onCommitted}
    />
  )
}

function ManagementUnavailable({ t, capabilities }: {
  readonly t: Translate
  readonly capabilities?: HostCapabilityProjection
}) {
  return (
    <div className={css.empty} role="status">
      <h3>{t('lifecycle.heading')}</h3>
      <p>{t('lifecycle.body')}</p>
      <code>{t('lifecycle.code')}</code>
      {capabilities === undefined ? null : <HostCapabilityStatus capabilities={capabilities} t={t} />}
    </div>
  )
}

function ManagementError({ error, t, onRetry }: { readonly error?: string; readonly t: Translate; readonly onRetry: () => void }) {
  return (
    <div className={css.managementError} role="alert">
      <strong>{t('management.unavailable')}</strong>
      <p>{t('management.unavailable.body')}</p>
      {error === undefined ? null : <code>{error}</code>}
      <button type="button" onClick={onRetry}>{t('management.retry')}</button>
    </div>
  )
}

function stateFact(label: string, value: string) {
  return <div><dt>{label}</dt><dd><code>{value}</code></dd></div>
}

function TaskConfigurationFlow({ row, management, t, onClose, onCreated }: {
  readonly row: TaskConfigurationRow
  readonly management: ExtensionManagementClient
  readonly t: Translate
  readonly onClose: () => void
  readonly onCreated: (planHash: string) => void
}) {
  const [state, setState] = useState<Readonly<{
    status: 'loading' | 'ready' | 'saving' | 'error'
    options?: Awaited<ReturnType<ExtensionManagementClient['configurationOptions']>>['options']
    error?: string
  }>>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    management.configurationOptions({
      candidateRef: row.candidateRef,
      operationKind: 'install',
      targetKey: null,
      scopeKey: row.scopeKey,
      profileId: row.profileId,
    }, controller.signal).then(response => {
      setState({ status: 'ready', options: response.options })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setState({ status: 'error', error: message(cause) })
    })
    return () => { controller.abort() }
  }, [management, row])

  if (state.status === 'loading') return <div className={css.managementLoading} role="status">{t('activity.loading')}</div>
  if (state.status === 'saving') return <div className={css.managementLoading} role="status">{t('approval.configuration.saving')}</div>
  if (state.status === 'error') {
    return <div className={css.managementError} role="alert"><strong>{t('plan.unavailable')}</strong><code>{state.error}</code><button type="button" onClick={onClose}>{t('action.cancel')}</button></div>
  }
  return (
    <McpConfigurationDraft
      options={state.options ?? []}
      initial={null}
      t={t}
      onDiscard={onClose}
      onSave={(configuration) => {
        setState(current => ({ ...current, status: 'saving', error: undefined }))
        management.configureTask({
          resolutionId: row.resolutionId,
          candidateRef: row.candidateRef,
          continuationId: row.continuationId,
          configuration,
        }).then(response => { onCreated(response.plan.hash) }).catch((cause: unknown) => {
          setState(current => ({ ...current, status: 'error', error: message(cause) }))
        })
      }}
    />
  )
}

function actionTitle(row: InventoryRow, operation: OperationKind, t: Translate): string {
  const availability = row.actions[operation]
  if (availability.status === 'available') return t('lifecycle.available')
  return `${availability.status}(${availability.reason})`
}

function candidateForAction(row: InventoryRow, operation: OperationKind): string | null {
  if (operation === 'update' && row.updateObservation.status === 'available') {
    return row.updateObservation.candidateRef
  }
  if (operation === 'restore' && row.restoreObservation.status === 'available') {
    return row.restoreObservation.candidateRef
  }
  return row.candidateRef
}

/** Managed inventory with independent lifecycle dimensions and staged configuration. */
export function InstalledPanel({ management, context, candidates, t }: ManagementPanelProps) {
  const [attempt, setAttempt] = useState(0)
  const [scopeKey, setScopeKey] = useState(context.defaultScopeKey)
  const inventory = useInventory(management, context, scopeKey, attempt)
  const [mutation, setMutation] = useState<MutationRequest>()
  const [configurationState, setConfigurationState] = useState<Readonly<{
    row: InventoryRow
    operationKind: OperationKind
    returnFocus: HTMLButtonElement
    status: 'loading' | 'ready' | 'error'
    options: Awaited<ReturnType<ExtensionManagementClient['configurationOptions']>>['options']
    currentConfiguration: RpcJson | null
    error?: string
  }>>()
  const [verificationState, setVerificationState] = useState<Readonly<{
    targetKey: string
    status: 'running' | 'error'
    error?: string
  }>>()

  if (inventory.status === 'unavailable') return <ManagementUnavailable t={t} />
  if (inventory.status === 'loading') return <div className={css.managementLoading} role="status">{t('inventory.loading')}</div>
  if (inventory.status === 'error') {
    return <ManagementError error={inventory.error} t={t} onRetry={() => { setAttempt(value => value + 1) }} />
  }
  const response = inventory.value!
  const rows = response.inventory.rows
  const writable = response.hostCapabilities.acquisition

  const launch = (
    row: InventoryRow,
    operationKind: OperationKind,
    configuration: RpcJson = {},
    returnFocus?: HTMLElement,
  ): void => {
    const candidateRef = candidateForAction(row, operationKind)
    if (candidateRef === null) return
    setMutation({
      id: `${row.targetKey}:${operationKind}:${String(Date.now())}`,
      candidateRef,
      operationKind,
      scopeKey: row.scopeKey,
      profileId: row.profileId,
      targetKey: row.targetKey,
      configuration,
      returnFocus,
    })
  }

  const prepareLifecycle = (row: InventoryRow, operationKind: OperationKind, returnFocus: HTMLButtonElement): void => {
    if (management === undefined) return
    const candidateRef = candidateForAction(row, operationKind)
    if (candidateRef === null) return
    const controller = new AbortController()
    setConfigurationState({ row, operationKind, returnFocus, status: 'loading', options: [], currentConfiguration: null })
    management.configurationOptions({
      candidateRef,
      operationKind,
      targetKey: row.targetKey,
      scopeKey: row.scopeKey,
      profileId: row.profileId,
    }, controller.signal).then((response) => {
      if (operationKind === 'configure') {
        setConfigurationState({
          row, operationKind, returnFocus, status: 'ready', options: response.options,
          currentConfiguration: response.currentConfiguration,
        })
      } else {
        setConfigurationState(undefined)
        launch(row, operationKind, response.currentConfiguration ?? {}, returnFocus)
      }
    }).catch((cause: unknown) => {
      setConfigurationState({
        row, operationKind, returnFocus, status: 'error', options: [], currentConfiguration: null,
        error: message(cause),
      })
    })
  }

  return (
    <div className={css.managementPanel}>
      <header className={css.panelHeading}>
        <div><h3>{t('installed.heading')}</h3><p>{t('installed.body')}</p></div>
        <div>
          <ManagementScopePicker value={scopeKey} t={t} onChange={(value) => {
            setMutation(undefined)
            setConfigurationState(undefined)
            setScopeKey(value)
          }} />
          <code>{response.inventory.revision}</code>
        </div>
      </header>
      {!response.inventory.complete ? <div className={css.inventoryWarning} role="status">{t('inventory.incomplete')}</div> : null}
      {!response.hostCapabilities.acquisition ? <ManagementUnavailable t={t} capabilities={response.hostCapabilities} /> : null}
      {rows.length === 0 ? <div className={css.empty}><h3>{t('inventory.empty')}</h3><p>{t('inventory.empty.body')}</p></div> : (
        <div className={css.inventoryList} aria-label={t('inventory.list')}>
          {rows.map(row => (
            <article key={`${row.kind}:${row.targetKey}`} className={css.inventoryCard} data-target-key={row.targetKey}>
              <header>
                <div><span>{row.kind}</span><h4>{row.extensionId}</h4><code>{row.managedRevision}</code></div>
                <span data-ownership={row.ownership}>{row.ownership}</span>
              </header>
              <dl className={css.stateGrid}>
                {stateFact(t('state.desired'), row.desired)}
                {stateFact(t('state.materialized'), row.materialized)}
                {stateFact(t('state.effective'), row.effective)}
                {stateFact(t('state.visibility'), row.agentVisibility)}
                {stateFact(t('state.verification'), row.verification)}
                {stateFact(t('state.rollback'), row.rollback)}
                {stateFact(t('state.ownership'), row.ownership)}
                {stateFact(t('state.configuration'), row.configurationRevision ?? t('field.notDeclared'))}
              </dl>
              <p className={css.targetLine}>{t('plan.target')} <code>{row.targetKey}</code> · {t('plan.scope')} <code>{row.scopeKey}</code></p>
              {row.updateObservation.status === 'available' ? (
                <p className={css.updateTarget}>
                  {t('updates.exactTarget')} <code>{row.updateObservation.revision}</code> · <code>{row.updateObservation.integrity}</code>
                </p>
              ) : null}
              <div className={css.lifecycleActions} aria-label={`${row.extensionId} ${t('field.lifecycle')}`}>
                <button
                  type="button"
                  disabled={verificationState?.targetKey === row.targetKey && verificationState.status === 'running'}
                  onClick={() => {
                    if (management === undefined) return
                    setVerificationState({ targetKey: row.targetKey, status: 'running' })
                    management.verify(row.scopeKey, row.profileId, row.targetKey).then(() => {
                      setVerificationState(undefined)
                      setAttempt(value => value + 1)
                    }).catch((cause: unknown) => {
                      setVerificationState({ targetKey: row.targetKey, status: 'error', error: message(cause) })
                    })
                  }}
                >{verificationState?.targetKey === row.targetKey && verificationState.status === 'running'
                    ? t('inventory.verify.running') : t('action.verify')}</button>
                {ACTIONS.map((operation) => {
                  const availability = row.actions[operation]
                  const candidateRef = candidateForAction(row, operation)
                  const disabled = !writable || availability.status !== 'available' || candidateRef === null
                  return (
                    <button
                      key={operation}
                      type="button"
                      disabled={disabled}
                      title={!writable ? t('lifecycle.code') : candidateRef === null ? t('action.noCandidate') : actionTitle(row, operation, t)}
                      onClick={(event) => {
                        prepareLifecycle(row, operation, event.currentTarget)
                      }}
                    >{t(`action.${operation}` as ExtensionCenterKey)}</button>
                  )
                })}
              </div>
              {verificationState?.targetKey === row.targetKey && verificationState.status === 'error' ? (
                <div className={css.managementError} role="alert">
                  <strong>{t('inventory.verify.failed')}</strong><code>{verificationState.error}</code>
                </div>
              ) : null}
              {configurationState?.row.targetKey !== row.targetKey ? null : configurationState.status === 'loading' ? (
                <div role="status">{t('inventory.loading')}</div>
              ) : configurationState.status === 'error' ? (
                <div className={css.managementError} role="alert">
                  <strong>{t('management.unavailable')}</strong><code>{configurationState.error}</code>
                  <button type="button" onClick={() => { setConfigurationState(undefined); configurationState.returnFocus.focus() }}>{t('action.cancel')}</button>
                </div>
              ) : row.candidateRef !== null && isCapabilityResolverCandidate(row.candidateRef) ? (
                <ResolverConfigDraft
                  initial={configurationState.currentConfiguration ?? undefined}
                  t={t}
                  onSave={(configuration) => {
                    launch(row, 'configure', configuration, configurationState.returnFocus)
                  }}
                  onDiscard={() => {
                    setConfigurationState(undefined)
                    configurationState.returnFocus.focus()
                  }}
                />
              ) : row.kind === 'plugin' ? (
                <div className={css.managementError} role="alert">
                  <strong>{t('management.unavailable')}</strong><code>{row.candidateRef ?? row.extensionId}</code>
                  <button type="button" onClick={() => { setConfigurationState(undefined); configurationState.returnFocus.focus() }}>{t('action.cancel')}</button>
                </div>
              ) : row.kind === 'mcp' ? (
                <McpConfigurationDraft
                  options={configurationState.options}
                  initial={configurationState.currentConfiguration}
                  t={t}
                  onSave={(configuration) => { launch(row, 'configure', configuration, configurationState.returnFocus) }}
                  onDiscard={() => { setConfigurationState(undefined); configurationState.returnFocus.focus() }}
                />
              ) : (
                <SkillConfigurationDraft
                  scopeKey={row.scopeKey}
                  initial={configurationState.currentConfiguration}
                  t={t}
                  onSave={(configuration) => { launch(row, 'configure', configuration, configurationState.returnFocus) }}
                  onDiscard={() => { setConfigurationState(undefined); configurationState.returnFocus.focus() }}
                />
              )}
            </article>
          ))}
        </div>
      )}
      {mutation === undefined || management === undefined ? null : (
        <MutationFlow
          key={mutation.id}
          request={mutation}
          candidate={candidates.get(mutation.candidateRef)}
          management={management}
          t={t}
          onClose={() => { setMutation(undefined); setAttempt(value => value + 1) }}
          onCommitted={() => {
            setConfigurationState(undefined)
          }}
        />
      )}
    </div>
  )
}

/** Exact observed update targets; updates never apply automatically. */
export function UpdatesPanel({ management, context, candidates, t }: ManagementPanelProps) {
  const [attempt, setAttempt] = useState(0)
  const [scopeKey, setScopeKey] = useState(context.defaultScopeKey)
  const inventory = useInventory(management, context, scopeKey, attempt)
  const [mutation, setMutation] = useState<MutationRequest>()
  const [configurationError, setConfigurationError] = useState<string>()
  const [loadingTarget, setLoadingTarget] = useState<string>()
  if (inventory.status === 'unavailable') return <ManagementUnavailable t={t} />
  if (inventory.status === 'loading') return <div className={css.managementLoading} role="status">{t('updates.loading')}</div>
  if (inventory.status === 'error') return <ManagementError error={inventory.error} t={t} onRetry={() => { setAttempt(value => value + 1) }} />
  const response = inventory.value!
  const writable = response.hostCapabilities.acquisition
  const rows = response.inventory.rows.filter((row) => row.updateObservation.status === 'available')
  return (
    <div className={css.managementPanel}>
      <header className={css.panelHeading}>
        <div><h3>{t('updates.heading')}</h3><p>{t('updates.body')}</p></div>
        <ManagementScopePicker value={scopeKey} t={t} onChange={(value) => {
          setMutation(undefined)
          setConfigurationError(undefined)
          setScopeKey(value)
        }} />
      </header>
      {!writable ? <ManagementUnavailable t={t} capabilities={response.hostCapabilities} /> : null}
      {configurationError === undefined ? null : <div className={css.managementError} role="alert"><code>{configurationError}</code></div>}
      {rows.length === 0 ? <div className={css.empty}><h3>{t('updates.empty')}</h3><p>{t('updates.empty.body')}</p></div> : (
        <div className={css.updateList} aria-label={t('updates.list')}>
          {rows.map((row) => {
            if (row.updateObservation.status !== 'available') return null
            const update = row.updateObservation
            const available = writable && row.actions.update.status === 'available'
            return (
              <article key={row.targetKey} className={css.updateCard}>
                <header><div><span>{row.kind}</span><h4>{row.extensionId}</h4></div><code>{row.managedRevision} → {update.revision}</code></header>
                <dl>
                  <div><dt>{t('updates.candidate')}</dt><dd><code>{update.candidateRef}</code></dd></div>
                  <div><dt>{t('updates.exactTarget')}</dt><dd><code>{update.revision}</code></dd></div>
                  <div><dt>{t('field.integrity')}</dt><dd><code>{update.integrity}</code></dd></div>
                </dl>
                <button type="button" disabled={!available || loadingTarget === row.targetKey} title={actionTitle(row, 'update', t)} onClick={(event) => {
                  if (management === undefined) return
                  const returnFocus = event.currentTarget
                  setLoadingTarget(row.targetKey)
                  setConfigurationError(undefined)
                  void management.configurationOptions({
                    candidateRef: update.candidateRef,
                    operationKind: 'update',
                    targetKey: row.targetKey,
                    scopeKey: row.scopeKey,
                    profileId: row.profileId,
                  }).then((response) => {
                    setLoadingTarget(undefined)
                    setMutation({
                      id: `${row.targetKey}:update:${String(Date.now())}`,
                      candidateRef: update.candidateRef,
                      operationKind: 'update',
                      scopeKey: row.scopeKey,
                      profileId: row.profileId,
                      targetKey: row.targetKey,
                      configuration: response.currentConfiguration ?? {},
                      returnFocus,
                    })
                  }).catch((cause: unknown) => {
                    setLoadingTarget(undefined)
                    setConfigurationError(message(cause))
                  })
                }}>{t('action.update')}</button>
              </article>
            )
          })}
        </div>
      )}
      {mutation === undefined || management === undefined ? null : (
        <MutationFlow
          key={mutation.id}
          request={mutation}
          candidate={candidates.get(mutation.candidateRef)}
          management={management}
          t={t}
          onClose={() => { setMutation(undefined); setAttempt(value => value + 1) }}
        />
      )}
    </div>
  )
}

/** Verified operation phases, receipts, and exact fenced recovery retry. */
export function ActivityPanel({ management, context, candidates, t }: ManagementPanelProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    readonly status: 'unavailable' | 'loading' | 'ready' | 'error'
    readonly operations?: Awaited<ReturnType<ExtensionManagementClient['operations']>>
    readonly receipts?: Awaited<ReturnType<ExtensionManagementClient['receipts']>>
    readonly inventory?: Awaited<ReturnType<ExtensionManagementClient['inventory']>>
    readonly approvals?: Awaited<ReturnType<ExtensionManagementClient['taskApprovals']>>
    readonly taskAttempts?: Awaited<ReturnType<ExtensionManagementClient['taskAttempts']>>
    readonly error?: string
  }>({ status: management === undefined ? 'unavailable' : 'loading' })
  const [recovery, setRecovery] = useState<Readonly<{
    operationId: string
    status: 'running' | 'error'
    error?: string
  }>>()
  const [selectedApproval, setSelectedApproval] = useState<string>()
  const [selectedConfiguration, setSelectedConfiguration] = useState<string>()
  const [taskAction, setTaskAction] = useState<Readonly<{
    taskAttemptId: string
    status: 'running' | 'error'
    error?: string
  }>>()

  useEffect(() => {
    if (management === undefined) {
      setState({ status: 'unavailable' })
      return
    }
    const controller = new AbortController()
    setState({ status: 'loading' })
    Promise.all([
      management.operations(controller.signal),
      management.receipts(controller.signal),
      management.inventory(context.defaultScopeKey, context.profileId, controller.signal),
      management.taskApprovals(controller.signal),
      management.taskAttempts(controller.signal),
    ]).then(([operations, receipts, inventory, approvals, taskAttempts]) => {
      setState({ status: 'ready', operations, receipts, inventory, approvals, taskAttempts })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setState({ status: 'error', error: message(cause) })
    })
    return () => { controller.abort() }
  }, [attempt, context.defaultScopeKey, context.profileId, management])

  if (state.status === 'unavailable') return <ManagementUnavailable t={t} />
  if (state.status === 'loading') return <div className={css.managementLoading} role="status">{t('activity.loading')}</div>
  if (state.status === 'error') return <ManagementError error={state.error} t={t} onRetry={() => { setAttempt(value => value + 1) }} />
  const operations = state.operations!.operations
  const approvals = state.approvals!.approvals
  const configurations = state.approvals!.configurations
  const taskAttempts = state.taskAttempts!.attempts
  const derivedSources = new Set(taskAttempts.flatMap(task => task.parentAttemptId === null ? [] : [task.parentAttemptId]))
  const approval = selectedApproval === undefined
    ? undefined
    : approvals.find(row => row.state.plan.hash === selectedApproval)
  const configuration = selectedConfiguration === undefined
    ? undefined
    : configurations.find(row => `${row.resolutionId}\u0000${row.candidateRef}` === selectedConfiguration)
  const receiptByOperation = new Map(state.receipts!.receipts.map(stored => [stored.operationId, stored]))
  const writable = state.inventory!.hostCapabilities.acquisition

  const recover = (operationId: string): void => {
    if (management === undefined) return
    const controller = new AbortController()
    setRecovery({ operationId, status: 'running' })
    management.recover(operationId, controller.signal).then(() => {
      setRecovery(undefined)
      setAttempt(value => value + 1)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setRecovery({ operationId, status: 'error', error: message(cause) })
    })
  }

  const runTaskAction = (taskAttemptId: string, action: (signal: AbortSignal) => Promise<unknown>): void => {
    const controller = new AbortController()
    setTaskAction({ taskAttemptId, status: 'running' })
    action(controller.signal).then(() => {
      setTaskAction(undefined)
      setAttempt(value => value + 1)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setTaskAction({ taskAttemptId, status: 'error', error: message(cause) })
    })
  }

  return (
    <div className={css.managementPanel}>
      <header className={css.panelHeading}><div><h3>{t('activity.heading')}</h3><p>{t('activity.body')}</p></div></header>
      {!writable ? <ManagementUnavailable t={t} capabilities={state.inventory!.hostCapabilities} /> : null}
      <section className={css.updateList} aria-labelledby="extension-center-task-attempts-heading">
        <header><h3 id="extension-center-task-attempts-heading">{t('taskAttempt.heading')}</h3><p>{t('taskAttempt.body')}</p></header>
        {taskAttempts.length === 0 ? <p>{t('taskAttempt.empty')}</p> : taskAttempts.map(task => {
          const running = taskAction?.taskAttemptId === task.taskAttemptId && taskAction.status === 'running'
          const actionError = taskAction?.taskAttemptId === task.taskAttemptId && taskAction.status === 'error'
            ? taskAction.error
            : undefined
          const derived = derivedSources.has(task.taskAttemptId)
          const retryContinuationCancellable = task.retryContinuation !== null
            && CANCELABLE_RETRY_CONTINUATION_STATES.has(task.retryContinuation.state)
          const cancellable = task.outcome === null || retryContinuationCancellable
          return (
            <article key={task.taskAttemptId} className={css.updateCard} data-task-outcome={task.outcome ?? 'active'}>
              <header>
                <div><span>{task.trigger}</span><h4>{t('taskAttempt.heading')}</h4></div>
                <code>{task.outcome ?? task.phase}</code>
              </header>
              <p>{t('taskAttempt.id')} <code>{task.taskAttemptId}</code></p>
              <p>{t('taskAttempt.phase')} <code>{task.phase}</code></p>
              {task.outcome === null ? <p>{t('taskAttempt.active')}</p> : <p>{t('taskAttempt.outcome')} <code>{task.outcome}</code></p>}
              {task.parentAttemptId === null ? null : <p>{t('taskAttempt.parent')} <code>{task.parentAttemptId}</code></p>}
              {task.choice === null ? null : (
                <div>
                  <p>{t('taskAttempt.choice')}</p>
                  <div className={css.inlineActions}>
                    {task.choice.candidateRefs.map(ref => (
                      <button
                        type="button"
                        key={ref}
                        disabled={!writable || running || derived}
                        onClick={() => { runTaskAction(task.taskAttemptId, signal => management!.selectTaskCandidate(task.taskAttemptId, ref, signal)) }}
                      >
                        {t('taskAttempt.select')} {t('locale.code') === 'zh' ? candidates.get(ref)?.displayName.zh ?? ref : candidates.get(ref)?.displayName.en ?? ref}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {task.management === null ? null : (
                <div>
                  <p>{t('taskAttempt.management')} <code>{task.management.action}</code></p>
                  <p>{t('taskAttempt.extensionRef')} <code>{task.management.extensionRef}</code></p>
                  <button
                    type="button"
                    disabled={!writable || running || derived}
                    onClick={() => { runTaskAction(task.taskAttemptId, signal => management!.retryOriginalTask(task.taskAttemptId, signal)) }}
                  >{t('taskAttempt.retryOriginal')}</button>
                </div>
              )}
              {task.acquisition === null ? null : <p>{t('taskAttempt.candidate')} <code>{task.acquisition.candidateRef}</code></p>}
              {task.retryContinuation === null ? null : (
                <p data-retry-continuation-state={task.retryContinuation.state}>
                  {t('taskAttempt.retryContinuation')} <strong>{t(RETRY_CONTINUATION_KEYS[task.retryContinuation.state])}</strong>
                </p>
              )}
              {!cancellable ? null : (
                <button
                  type="button"
                  disabled={!writable || running}
                  onClick={() => { runTaskAction(task.taskAttemptId, signal => management!.cancelTaskAttempt(task.taskAttemptId, signal)) }}
                >{t(retryContinuationCancellable ? 'taskAttempt.cancelContinuation' : 'taskAttempt.cancel')}</button>
              )}
              {derived ? <p>{t('taskAttempt.derived')}</p> : null}
              {actionError === undefined ? null : <div className={css.managementError} role="alert"><code>{actionError}</code></div>}
            </article>
          )
        })}
      </section>
      <section className={css.updateList} aria-labelledby="extension-center-task-configurations-heading">
        <header><h3 id="extension-center-task-configurations-heading">{t('approval.configuration.heading')}</h3><p>{t('approval.configuration.body')}</p></header>
        {configurations.length === 0 ? <p>{t('approval.configuration.empty')}</p> : configurations.map(row => (
          <article key={`${row.resolutionId}\u0000${row.candidateRef}`} className={css.updateCard}>
            <header><div><span>{row.extensionKind}</span><h4>{t('locale.code') === 'zh' ? candidates.get(row.candidateRef)?.displayName.zh ?? row.candidateRef : candidates.get(row.candidateRef)?.displayName.en ?? row.candidateRef}</h4></div><code>{t('approval.configuration.required')}</code></header>
            <p><code>{row.candidateRef}</code></p>
            <p>{t('plan.scope')} <code>{row.scopeKey} / {row.profileId}</code></p>
            <button type="button" disabled={!writable} onClick={() => { setSelectedConfiguration(`${row.resolutionId}\u0000${row.candidateRef}`) }}>{t('approval.configuration.open')}</button>
          </article>
        ))}
        {configuration === undefined || management === undefined ? null : (
          <TaskConfigurationFlow
            row={configuration}
            management={management}
            t={t}
            onClose={() => { setSelectedConfiguration(undefined) }}
            onCreated={(planHash) => {
              setSelectedConfiguration(undefined)
              setSelectedApproval(planHash)
              setAttempt(value => value + 1)
            }}
          />
        )}
      </section>
      <section className={css.updateList} aria-labelledby="extension-center-task-approvals-heading">
        <header><h3 id="extension-center-task-approvals-heading">{t('approval.heading')}</h3><p>{t('approval.body')}</p></header>
        {approvals.length === 0 ? <p>{t('approval.empty')}</p> : approvals.map(row => (
          <article key={row.state.plan.hash} className={css.updateCard}>
            <header><div><span>{row.state.status}</span><h4>{row.state.plan.content.extensionId}</h4></div><code>{row.state.plan.content.operationKind}</code></header>
            <p><code>{row.state.plan.content.candidateRef}</code></p>
            <p>{t('plan.scope')} <code>{row.state.plan.content.scopeKey} / {row.state.plan.content.profileId}</code></p>
            <button type="button" disabled={!writable} onClick={() => { setSelectedApproval(row.state.plan.hash) }}>{t('approval.review')}</button>
          </article>
        ))}
        {approval === undefined || management === undefined ? null : (
          <PlanReview
            preview={{
              protocolVersion: 1,
              intentId: approval.state.plan.content.intentId,
              plan: approval.state.plan,
              policy: {
                status: 'eligible',
                policyRevision: 'extension-center-p0-policy-v2',
                authorityDigest: approval.state.plan.content.authorityDigest,
              },
            }}
            candidate={candidates.get(approval.state.plan.content.candidateRef)}
            management={management}
            configuration={approval.configuration}
            initialState={approval.state}
            t={t}
            onClose={() => { setSelectedApproval(undefined); setAttempt(value => value + 1) }}
            onCommitted={() => { setSelectedApproval(undefined); setAttempt(value => value + 1) }}
          />
        )}
      </section>
      {operations.length === 0 ? <div className={css.empty}><h3>{t('activity.empty')}</h3><p>{t('activity.empty.body')}</p></div> : (
        <ol className={css.activityList} aria-label={t('activity.list')}>
          {operations.map((operation) => {
            const stored = receiptByOperation.get(operation.operationId)
            const recovering = recovery?.operationId === operation.operationId && recovery.status === 'running'
            const recoveryError = recovery?.operationId === operation.operationId && recovery.status === 'error'
              ? recovery.error
              : undefined
            return (
              <li key={operation.operationId} data-operation-phase={operation.phase}>
                <article className={css.activityCard}>
                  <header>
                    <div><span>{operation.operationKind}</span><h4>{operation.targetKey}</h4></div>
                    <code>{operation.phase}</code>
                  </header>
                  <p>{t('operation.id')} <code>{operation.operationId}</code></p>
                  <p>{t('operation.updated')} <time dateTime={new Date(operation.lastAtMs).toISOString()}>{new Date(operation.lastAtMs).toLocaleString()}</time></p>
                  {stored === undefined ? <p>{t('receipt.pending')}</p> : (
                    <dl>
                      <div><dt>{t('receipt.outcome')}</dt><dd><code>{stored.receipt.body.outcome}</code></dd></div>
                      <div><dt>{t('receipt.source')}</dt><dd><code>{stored.receipt.body.planEvidence.candidateRef}</code> · <code>{stored.receipt.body.planEvidence.artifactUrl}</code></dd></div>
                      <div><dt>{t('receipt.version')}</dt><dd><code>{stored.receipt.body.planEvidence.artifactRevision}</code></dd></div>
                      <div><dt>{t('receipt.integrity')}</dt><dd><code>{stored.receipt.body.planEvidence.artifactIntegrity}</code></dd></div>
                      <div><dt>{t('receipt.scope')}</dt><dd><code>{stored.receipt.body.planEvidence.scopeKey} / {stored.receipt.body.planEvidence.profileId}</code></dd></div>
                      <div><dt>{t('receipt.configuration')}</dt><dd><code>{stored.receipt.body.planEvidence.configurationDigest}</code></dd></div>
                      <div><dt>{t('receipt.authority')}</dt><dd><code>{stored.receipt.body.planEvidence.authorityDigest}</code></dd></div>
                      <div><dt>{t('receipt.retention')}</dt><dd><code>{stored.receipt.body.planEvidence.retentionDigest}</code></dd></div>
                      <div><dt>{t('receipt.mutation')}</dt><dd><code>{stored.receipt.body.evidence.mutation}</code> · <code>{stored.receipt.body.planEvidence.mutationDigest}</code></dd></div>
                      <div><dt>{t('receipt.verification')}</dt><dd><code>{stored.receipt.body.evidence.verification}</code> · <code>{stored.receipt.body.planEvidence.verificationDigest}</code></dd></div>
                      <div><dt>{t('receipt.rollback')}</dt><dd><code>{stored.receipt.body.evidence.rollback.status}</code></dd></div>
                      <div><dt>{t('receipt.restart')}</dt><dd><code>{stored.receipt.body.evidence.restart.status}</code></dd></div>
                      <div><dt>{t('receipt.recovery')}</dt><dd><code>{stored.receipt.body.evidence.recovery.status}</code> · {stored.receipt.body.evidence.recovery.attempts}</dd></div>
                      <div><dt>{t('review.checksRun')}</dt><dd><code>{stored.receipt.body.evidence.checksActuallyRun.map(item => `${item.phase}:${item.code}`).join(', ')}</code></dd></div>
                      <div><dt>{t('receipt.notProven')}</dt><dd>{stored.receipt.body.evidence.notProven.length === 0 ? t('field.none') : <code>{stored.receipt.body.evidence.notProven.join(', ')}</code>}</dd></div>
                      <div><dt>{t('plan.managedObject')}</dt><dd><code>{stored.receipt.body.managedObject}</code></dd></div>
                      <div><dt>{t('plan.externalRuntimeAction')}</dt><dd><code>{stored.receipt.body.externalRuntimeAction}</code></dd></div>
                      {stored.receipt.body.runtimeBinding === null ? null : (
                        <>
                          <div><dt>{t('plan.runtimeRef')}</dt><dd><code>{stored.receipt.body.runtimeBinding.runtimeRef}</code></dd></div>
                          <div><dt>{t('plan.runtimeVersion')}</dt><dd><code>{stored.receipt.body.runtimeBinding.version}</code></dd></div>
                          <div><dt>{t('plan.runtimeDescriptorDigest')}</dt><dd><code>{stored.receipt.body.runtimeBinding.descriptorDigest}</code></dd></div>
                        </>
                      )}
                      <div><dt>{t('receipt.digest')}</dt><dd><code>{stored.receipt.digest}</code></dd></div>
                      <div><dt>{t('receipt.journal')}</dt><dd>{stored.receipt.body.journalEventCount} · <code>{stored.receipt.body.journalHeadDigest}</code></dd></div>
                    </dl>
                  )}
                  {stored === undefined ? null : <ReviewEvidenceDetails evidence={stored.receipt.body.planEvidence.reviewEvidence} t={t} />}
                  {operation.phase !== 'recovery-required'
                    && operation.recoveryNotice !== 'retired-runtime-quarantined' ? null : (
                    <div className={css.recoveryCallout} role="alert">
                      <strong>{t('recovery.required')}</strong>
                      <p>{operation.recoveryNotice === 'retired-runtime-quarantined'
                        ? t('recovery.retiredRuntime')
                        : t('recovery.required.body')}</p>
                      {operation.recoveryCommand === null ? null : (
                        <>
                          <p>{t('recovery.command')}</p>
                          <pre>{JSON.stringify(operation.recoveryCommand)}</pre>
                          <p>{t('recovery.reconciliationPending')}</p>
                        </>
                      )}
                      {recoveryError === undefined ? null : <code>{recoveryError}</code>}
                      {operation.recoveryNotice === 'retired-runtime-quarantined' ? null : (
                        <button type="button" disabled={!writable || recovering} onClick={() => { recover(operation.operationId) }}>
                          {recovering ? t('recovery.running') : t('action.recover')}
                        </button>
                      )}
                    </div>
                  )}
                </article>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
