import { useEffect, useRef, useState } from 'react'
import type { CatalogEntry, LocalizedText } from '../catalog-contract.ts'
import type { PlanAuthorizationState } from '../plans/types.ts'
import type { PlanReviewEvidence } from '../plans/types.ts'
import type { IntentPreviewResponse, LifecycleResponse, RpcJson } from '../service/rpc-contract.ts'
import type { ExtensionCenterKey } from './locales.ts'
import { configurationDigest, type ExtensionManagementClient } from './management-api.ts'
import css from './ExtensionCenter.module.css'

type Translate = (key: ExtensionCenterKey) => string

function localize(value: LocalizedText, language: 'en' | 'zh'): string {
  return value[language]
}

function configurationDiff(value: RpcJson): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.entries(value).map(([key, child]) => `+ ${key}: ${JSON.stringify(child)}`).join('\n')
  }
  return `+ value: ${JSON.stringify(value)}`
}

/** Ordinary-user projection of the exact kind-specific facts protected by the plan hash. */
export function ReviewEvidenceDetails({ evidence, t }: Readonly<{ evidence: PlanReviewEvidence; t: Translate }>) {
  const exact = evidence.kind === 'plugin'
    ? {
        manifest: evidence.manifest,
        dependencies: evidence.dependencies,
        lockfile: evidence.lockfile,
        bundles: evidence.bundles,
        scripts: evidence.scripts,
        settings: evidence.settings,
      }
    : evidence.kind === 'skill'
      ? { files: evidence.files, invocation: evidence.invocation, before: evidence.body.before, after: evidence.body.after }
      : {
          descriptor: evidence.descriptor,
          runtime: evidence.runtime,
          credentials: evidence.credentials,
          dataEgress: evidence.dataEgress,
        }
  return (
    <section className={css.configurationDiff} aria-label={t('review.heading')}>
      <h4>{t('review.heading')}</h4>
      <p>{t('review.body')}</p>
      <dl className={css.planFacts}>
        <div><dt>{t('review.checks')}</dt><dd><code>{evidence.checks.map(item => `${item.phase}:${item.code}`).join(', ')}</code></dd></div>
        <div><dt>{t('review.removed')}</dt><dd><code>{evidence.removed.length === 0 ? t('field.none') : evidence.removed.map(item => `${item.kind}:${item.id}`).join(', ')}</code></dd></div>
        <div><dt>{t('review.retained')}</dt><dd><code>{evidence.retained.length === 0 ? t('field.none') : evidence.retained.map(item => `${item.kind}:${item.id}`).join(', ')}</code></dd></div>
        <div><dt>{t('review.credentials')}</dt><dd><code>{evidence.credentialChoice}</code></dd></div>
        <div><dt>{t('review.rollback')}</dt><dd><code>{evidence.rollbackPoint === null ? t('field.none') : `${evidence.rollbackPoint.kind}:${evidence.rollbackPoint.id} @ ${evidence.rollbackPoint.digest}`}</code></dd></div>
        <div><dt>{t('review.limits')}</dt><dd><code>{evidence.rollbackLimits.join(', ') || t('field.none')}</code></dd></div>
        <div><dt>{t('review.notProven')}</dt><dd><code>{evidence.notProven.join(', ') || t('field.none')}</code></dd></div>
      </dl>
      <h4>{t(`review.${evidence.kind}`)}</h4>
      <pre>{JSON.stringify(exact, null, 2)}</pre>
    </section>
  )
}

/** Props for one exact, single-use human plan decision. */
export interface PlanReviewProps {
  readonly preview: IntentPreviewResponse
  readonly candidate?: CatalogEntry
  readonly management: ExtensionManagementClient
  readonly configuration?: RpcJson
  readonly initialState?: Extract<PlanAuthorizationState, { status: 'pending' | 'approved' }>
  readonly t: Translate
  readonly onClose: () => void
  readonly onCommitted?: (result: LifecycleResponse) => void
}

/** Render the immutable plan and keep decision separate from lifecycle execution. */
export function PlanReview({ preview, candidate, management, configuration, initialState, t, onClose, onCommitted }: PlanReviewProps) {
  const [busy, setBusy] = useState<'approve' | 'reject'>()
  const [decisionLocked, setDecisionLocked] = useState(false)
  const [error, setError] = useState<string>()
  const [planStatus, setPlanStatus] = useState<PlanAuthorizationState['status']>(initialState?.status ?? 'pending')
  const [result, setResult] = useState<LifecycleResponse>()
  const [configDigest, setConfigDigest] = useState<string>()
  const [expired, setExpired] = useState(() => Date.now() >= preview.plan.content.expiresAtMs)
  const surface = useRef<HTMLElement>(null)
  const request = useRef<AbortController>()
  const decisionClaimed = useRef(false)
  const language: 'en' | 'zh' = t('locale.code') === 'zh' ? 'zh' : 'en'
  const { plan, policy } = preview

  useEffect(() => {
    surface.current?.focus()
    return () => { request.current?.abort() }
  }, [])

  useEffect(() => {
    if (configuration === undefined) {
      setConfigDigest(undefined)
      return
    }
    let active = true
    void configurationDigest(configuration).then((value) => {
      if (active) setConfigDigest(value)
    }).catch(() => {
      if (active) setConfigDigest(t('plan.digestUnavailable'))
    })
    return () => { active = false }
  }, [configuration, t])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = (): void => {
      const remaining = plan.content.expiresAtMs - Date.now()
      if (remaining <= 0) {
        setExpired(true)
        return
      }
      setExpired(false)
      timer = setTimeout(check, Math.min(remaining, 2_147_483_647))
    }
    check()
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [plan.content.expiresAtMs])

  const decide = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (decisionClaimed.current) return
    decisionClaimed.current = true
    setDecisionLocked(true)
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(decision)
    setError(undefined)
    try {
      const state = await management.decide(plan, decision, controller.signal)
      setPlanStatus(state.status)
      if (decision === 'reject') {
        if (state.status !== 'rejected') throw new Error(`decision returned ${state.status}`)
        return
      }
      if (state.status !== 'approved') throw new Error(`decision returned ${state.status}`)
      await executeApproved(controller)
    } catch (cause: unknown) {
      if (controller.signal.aborted) return
      await reconcile(cause, controller)
    } finally {
      if (!controller.signal.aborted) setBusy(undefined)
    }
  }

  const executeApproved = async (controller: AbortController): Promise<void> => {
    try {
      const lifecycle = await management.execute(plan.hash, controller.signal)
      setResult(lifecycle)
      onCommitted?.(lifecycle)
    } catch (cause: unknown) {
      if (controller.signal.aborted) return
      await reconcile(cause, controller)
    }
  }

  const reconcile = async (cause: unknown, controller: AbortController): Promise<void> => {
    try {
      const current = await management.plan(plan.hash, controller.signal)
      if (current === null) throw new Error('plan reconciliation returned absent')
      setPlanStatus(current.status)
      if (current.status === 'pending' || current.status === 'approved') {
        decisionClaimed.current = false
        setDecisionLocked(false)
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    } catch (reconcileCause: unknown) {
      setError(`${cause instanceof Error ? cause.message : String(cause)}; ${reconcileCause instanceof Error ? reconcileCause.message : String(reconcileCause)}`)
    }
  }

  const resume = async (): Promise<void> => {
    if (decisionClaimed.current || planStatus !== 'approved') return
    decisionClaimed.current = true
    setDecisionLocked(true)
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy('approve')
    setError(undefined)
    await executeApproved(controller)
    if (!controller.signal.aborted) setBusy(undefined)
  }

  const candidateBound = candidate !== undefined
    && candidate.candidateRef === plan.content.candidateRef
    && candidate.kind === plan.content.extensionKind
    && candidate.name === plan.content.extensionId
    && candidate.artifact.version === plan.content.artifactRevision
    && candidate.artifact.integrity === plan.content.artifactIntegrity
  const permissions = candidateBound
    ? candidate.permissions.filter(permission => permission.access !== 'none')
    : []
  const restart = candidateBound
    ? `${candidate.restart.required ? t('restart.required') : t('restart.notRequired')} · ${localize(candidate.restart.detail, language)}`
    : t('field.notDeclared')
  const retention = candidateBound ? localize(candidate.retainedData, language) : t('field.notDeclared')

  return (
    <section
      ref={surface}
      className={css.planReview}
      aria-labelledby="extension-center-plan-heading"
      tabIndex={-1}
      data-plan-hash={plan.hash}
    >
      <header>
        <div>
          <span>{t('plan.eyebrow')}</span>
          <h3 id="extension-center-plan-heading">{t('plan.heading')}</h3>
          <p>{t('plan.body')}</p>
        </div>
        <button type="button" onClick={onClose}>{t('plan.close')}</button>
      </header>

      {policy.status === 'denied' ? (
        <div className={css.planDenied} role="alert">
          <strong>{t('plan.denied')}</strong>
          <code>{policy.code}</code>
          <p>{policy.reason}</p>
        </div>
      ) : null}

      {!candidateBound ? (
        <div className={css.planDenied} role="alert">
          <strong>{t('plan.candidateUnavailable')}</strong>
          <p>{t('plan.candidateUnavailable.body')}</p>
        </div>
      ) : null}
      {expired ? (
        <div className={css.planDenied} role="alert">
          <strong>{t('plan.expired')}</strong>
          <p>{t('plan.expired.body')}</p>
        </div>
      ) : null}

      <dl className={css.planFacts}>
        <div><dt>{t('plan.operation')}</dt><dd><code>{plan.content.operationKind}</code></dd></div>
        <div><dt>{t('field.type')}</dt><dd>{plan.content.extensionKind}</dd></div>
        <div><dt>{t('plan.candidate')}</dt><dd><code>{plan.content.candidateRef}</code></dd></div>
        <div><dt>{t(plan.content.managedObject === 'connection' ? 'field.catalogReferenceVersion' : 'field.version')}</dt><dd><code>{plan.content.artifactRevision}</code></dd></div>
        <div><dt>{t(plan.content.managedObject === 'connection' ? 'field.catalogReferenceIntegrity' : 'field.integrity')}</dt><dd><code>{plan.content.artifactIntegrity}</code></dd></div>
        <div><dt>{t('plan.managedObject')}</dt><dd><code>{plan.content.managedObject}</code></dd></div>
        <div><dt>{t('plan.externalRuntimeAction')}</dt><dd><code>{plan.content.externalRuntimeAction}</code></dd></div>
        {plan.content.runtimeBinding === null ? null : (
          <>
            <div><dt>{t('plan.runtimeRef')}</dt><dd><code>{plan.content.runtimeBinding.runtimeRef}</code></dd></div>
            <div><dt>{t('plan.runtimeVersion')}</dt><dd><code>{plan.content.runtimeBinding.version}</code></dd></div>
            <div><dt>{t('plan.runtimeDescriptorDigest')}</dt><dd><code>{plan.content.runtimeBinding.descriptorDigest}</code></dd></div>
          </>
        )}
        <div><dt>{t('plan.target')}</dt><dd><code>{plan.content.targetKey}</code></dd></div>
        <div><dt>{t('plan.scope')}</dt><dd><code>{plan.content.scopeKey} / {plan.content.profileId}</code></dd></div>
        <div><dt>{t('plan.desired')}</dt><dd><code>{plan.content.desiredState}</code></dd></div>
        <div><dt>{t('field.restart')}</dt><dd>{restart}</dd></div>
        <div><dt>{t('field.retention')}</dt><dd>{retention}</dd></div>
        <div><dt>{t('plan.authorityDigest')}</dt><dd><code>{plan.content.authorityDigest}</code></dd></div>
        <div><dt>{t('plan.configurationDigest')}</dt><dd><code>{plan.content.configurationDigest}</code></dd></div>
        <div><dt>{t('plan.mutationDigest')}</dt><dd><code>{plan.content.mutationDigest}</code></dd></div>
        <div><dt>{t('plan.verificationDigest')}</dt><dd><code>{plan.content.verificationDigest}</code></dd></div>
        <div><dt>{t('plan.hash')}</dt><dd><code>{plan.hash}</code></dd></div>
        <div><dt>{t('plan.expires')}</dt><dd><time dateTime={new Date(plan.content.expiresAtMs).toISOString()}>{new Date(plan.content.expiresAtMs).toLocaleString()}</time></dd></div>
        <div><dt>{t('plan.singleUse')}</dt><dd>{t('plan.singleUse.yes')}</dd></div>
      </dl>

      {plan.content.managedObject === 'connection' ? <p>{t('mcpConfig.noArtifactAcquisition')}</p> : null}

      <ReviewEvidenceDetails evidence={plan.content.reviewEvidence} t={t} />

      <section className={css.planPermissions} aria-labelledby="extension-center-plan-permissions">
        <h4 id="extension-center-plan-permissions">{t('field.permissions')}</h4>
        {permissions.length === 0 ? <p>{t('field.none')}</p> : (
          <ul>{permissions.map((permission, index) => (
            <li key={`${permission.phase}-${permission.kind}-${index}`}>
              <strong>{permission.phase} · {permission.kind} · {permission.access}</strong>
              <span>{localize(permission.detail, language)}</span>
            </li>
          ))}</ul>
        )}
      </section>

      {configuration === undefined ? null : (
        <section className={css.configurationDiff} aria-labelledby="extension-center-plan-configuration">
          <h4 id="extension-center-plan-configuration">{t('plan.configurationDiff')}</h4>
          <pre>{configurationDiff(configuration) || t('field.none')}</pre>
          <p>{t('plan.configurationDigest')} <code>{configDigest ?? t('plan.digesting')}</code></p>
          <p>{t('field.restart')} · {restart}</p>
        </section>
      )}

      {planStatus === 'rejected' ? (
        <div className={css.decisionResult} role="status">
          <strong>{t('plan.rejected')}</strong>
          <p>{t('plan.rejected.body')}</p>
        </div>
      ) : null}
      {result === undefined ? null : (
        <div className={css.decisionResult} role="status">
          <strong>{result.status === 'recovery-required'
            ? t('recovery.required')
            : result.status === 'restart-required' ? t('operation.restartRequired') : t('operation.started')}</strong>
          {result.status === 'recovery-required' ? <p>{t('recovery.required.body')}</p> : null}
          <p>{t('operation.id')} <code>{result.operationId}</code> · {t('operation.phase')} <code>{result.status}</code></p>
          {result.receipt === null ? null : <p>{t('receipt.digest')} <code>{result.receipt.digest}</code></p>}
        </div>
      )}
      {error === undefined ? null : (
        <div className={css.mutationError} role="alert">
          <strong>{t('operation.uncertain')}</strong>
          <p>{planStatus === 'pending' ? t('operation.notRecorded') : t('operation.uncertain.body')}</p>
          <code>{error}</code>
        </div>
      )}

      {policy.status === 'eligible' && planStatus === 'pending' && result === undefined ? (
        <div className={css.decisionActions} aria-label={t('plan.decision')}>
          <button type="button" disabled={busy !== undefined || decisionLocked} onClick={() => { void decide('reject') }}>
            {busy === 'reject' ? t('plan.rejecting') : t('plan.reject')}
          </button>
          <button
            type="button"
            className={css.primaryAction}
            disabled={busy !== undefined || decisionLocked || !candidateBound || expired}
            title={!candidateBound ? t('plan.candidateUnavailable') : expired ? t('plan.expired') : undefined}
            onClick={() => { void decide('approve') }}
          >
            {busy === 'approve' ? t('plan.approving') : t('plan.approve')}
          </button>
        </div>
      ) : null}
      {policy.status === 'eligible' && planStatus === 'approved' && result === undefined ? (
        <div className={css.decisionActions} aria-label={t('plan.decision')}>
          <button type="button" className={css.primaryAction} disabled={busy !== undefined || decisionLocked || !candidateBound} onClick={() => { void resume() }}>
            {busy === 'approve' ? t('operation.resuming') : t('operation.resume')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
