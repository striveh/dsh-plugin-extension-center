import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
      const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
      document.addEventListener('keydown', close)
      return () => { document.removeEventListener('keydown', close) }
    }, [onClose, open])
    return open ? <div role="dialog" aria-modal="true" aria-label={title} className={className}>{children}</div> : null
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
          listeners.forEach(listener => { listener() })
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
  ExtensionCenterOverlay,
  ExtensionCenterTrigger,
  type ExtensionCenterOverlayProps,
  type ExtensionCenterTriggerProps,
} from '../src/client/ExtensionCenter.tsx'
import type { ExtensionCatalogClient } from '../src/client/catalog-api.ts'
import { en, zh, type ExtensionCenterKey } from '../src/client/locales.ts'
import type { ExtensionManagementClient, StorePreviewInput } from '../src/client/management-api.ts'
import { createExtensionCenterStore } from '../src/client/store.ts'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../src/catalog-data.ts'
import { catalogListResponse, verifyBootstrapCatalog } from '../src/catalog.ts'
import { canonicalSha256 } from '../src/domain/index.ts'
import { createInventorySnapshot, type InventoryRow } from '../src/inventory/index.ts'
import type { OperationReceipt } from '../src/operations/index.ts'
import type { HostCapabilityProjection, InventoryListResponse, RpcJson } from '../src/service/rpc-contract.ts'
import { CAPABILITY_RESOLVER_CANDIDATES } from '../src/resolver-candidates.ts'
import {
  createImmutablePlan,
  createPlanAuthorizationState,
  decidePlan,
  type ImmutablePlan,
  type OperationKind,
  type PlanAuthorizationState,
  type PlanUseContext,
} from '../src/plans/index.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const NOW = Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW + 10) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const hostCapabilities = {
  managedPluginLifecycle: true,
  dynamicMcpConnection: true,
  durableContinuation: true,
  skillRegistry: true,
  toolRegistry: true,
  loaderMutation: true,
  acquisition: true,
  reason: null,
} as const
const catalogSnapshot = catalogListResponse(verifyBootstrapCatalog(NOW), hostCapabilities)
const skill = catalogSnapshot.entries.find(entry => entry.kind === 'skill')!
const plugin = catalogSnapshot.entries.find(entry => entry.kind === 'plugin')!
const mcp = catalogSnapshot.entries.find(entry => entry.kind === 'mcp')!
const skillTargetKey = `skill:user/${skill.name}`
const pluginTargetKey = `plugin:profile:web/${plugin.name}`

function digest(label: string) {
  return canonicalSha256({ label })
}

function inventoryResponse(
  capabilities: HostCapabilityProjection = hostCapabilities,
  resolverCandidateRef = plugin.candidateRef,
  resolverUpdate: InventoryRow['updateObservation'] = { status: 'none' },
  resolverRestore: InventoryRow['restoreObservation'] = { status: 'none' },
): InventoryListResponse {
  const row: Omit<InventoryRow, 'actions'> = {
    schemaVersion: 1,
    kind: 'skill',
    extensionId: skill.name,
    candidateRef: skill.candidateRef,
    targetKey: skillTargetKey,
    scopeKey: 'profile:web',
    profileId: 'web',
    ownership: 'center',
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    agentVisibility: 'visible',
    verification: 'runtime',
    rollback: 'available',
    managedRevision: skill.artifact.version,
    ownerRevision: 'owner:7',
    configurationRevision: 'configuration:3',
    observedAtMs: NOW,
    updateObservation: {
      status: 'available',
      candidateRef: skill.candidateRef,
      revision: `${skill.artifact.version}+admitted.2`,
      integrity: skill.artifact.integrity,
    },
    restoreObservation: { status: 'none' },
    evidence: {
      kind: 'skill',
      contentRevision: skill.source.revision,
      catalogComplete: true,
      winningProvider: 'extension-center',
      winningPath: `/managed/${skill.name}/SKILL.md`,
      definitionLoaded: true,
      invocation: { modelInvocable: true, userInvocable: true },
    },
  }
  const pluginRow: Omit<InventoryRow, 'actions'> = {
    schemaVersion: 1,
    kind: 'plugin',
    extensionId: plugin.name,
    candidateRef: resolverCandidateRef,
    targetKey: pluginTargetKey,
    scopeKey: 'profile:web',
    profileId: 'web',
    ownership: 'center',
    desired: 'enabled',
    materialized: 'configured',
    effective: 'active',
    agentVisibility: 'visible',
    verification: 'runtime',
    rollback: 'available',
    managedRevision: plugin.artifact.version,
    ownerRevision: 'owner:plugin:2',
    configurationRevision: 'configuration:resolver:1',
    observedAtMs: NOW,
    updateObservation: resolverUpdate,
    restoreObservation: resolverRestore,
    evidence: {
      kind: 'plugin',
      restartToken: 'generation:2',
      loaderPhase: 'active',
      consumerObserved: true,
      restartObserved: true,
    },
  }
  return {
    protocolVersion: 1 as const,
    hostCapabilities: capabilities,
    inventory: createInventorySnapshot({
      scopeKey: 'profile:web', profileId: 'web', complete: true, observedAtMs: NOW, rows: [pluginRow, row],
    }, capabilities),
  }
}

function planFor(input: StorePreviewInput): ImmutablePlan {
  const candidate = catalogSnapshot.entries.find(entry => entry.candidateRef === input.candidateRef) ?? skill
  return createImmutablePlan({
    schemaVersion: 1,
    singleUse: true,
    planId: `plan:${input.operationKind}:${input.scopeKey}`,
    intentId: `intent:${input.operationKind}:${input.scopeKey}`,
    origin: 'store',
    candidateRef: input.candidateRef,
    extensionKind: candidate.kind,
    extensionId: candidate.name,
    managedObject: candidate.kind === 'mcp' ? 'connection' : 'artifact',
    externalRuntimeAction: candidate.kind === 'mcp'
      || (input.operationKind !== 'install' && input.operationKind !== 'update')
      ? 'none'
      : 'download',
    runtimeBinding: candidate.kind === 'mcp'
      ? {
          runtimeRef: 'runtime:filesystem-mcp-1.3.0',
          version: '1.3.0',
          descriptorDigest: digest('runtime:filesystem-mcp-1.3.0'),
        }
      : null,
    artifactRevision: input.operationKind === 'update' ? `${candidate.artifact.version}+admitted.2` : candidate.artifact.version,
    artifactIntegrity: candidate.artifact.integrity,
    artifactUrl: candidate.artifact.acquisitionUrl,
    artifactSizeBytes: candidate.artifact.sizeBytes,
    operationKind: input.operationKind,
    desiredState: input.operationKind === 'uninstall' || input.operationKind === 'purge' ? 'removed'
      : input.operationKind === 'disable' ? 'disabled' : 'enabled',
    targetKey: input.targetKey ?? `${candidate.kind}:${input.scopeKey}/${candidate.name}`,
    ownerKey: `${candidate.kind}-owner:${input.scopeKey}`,
    scopeKey: input.scopeKey,
    profileId: input.profileId,
    idempotencyKey: `idempotency:${input.operationKind}:${input.scopeKey}`,
    authorityDigest: digest(`authority:${input.operationKind}`),
    configurationDigest: canonicalSha256(input.configuration),
    retentionDigest: canonicalSha256({ candidateRef: candidate.candidateRef, retainedData: candidate.retainedData }),
    reviewEvidence: testReviewEvidence(candidate.kind, input.operationKind),
    mutationDigest: digest(`mutation:${input.operationKind}`),
    verificationDigest: digest(`verification:${input.operationKind}`),
    restartRequired: candidate.kind === 'plugin' && input.operationKind === 'configure'
      ? false
      : candidate.restart.required,
    createdAtMs: NOW,
    expiresAtMs: NOW + 60_000,
    fences: {
      catalogRevision: 2,
      inventoryRevision: inventoryResponse().inventory.revision,
      targetRevision: 'target:3',
      ownerRevision: 'owner:7',
      scopeRevision: 'scope:4',
      profileRevision: 'profile:5',
    },
  })
}

function planContext(plan: ImmutablePlan): PlanUseContext {
  return {
    operationKind: plan.content.operationKind,
    targetKey: plan.content.targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    fences: plan.content.fences,
  }
}

function decided(plan: ImmutablePlan, decision: 'approve' | 'reject'): PlanAuthorizationState {
  return decidePlan(createPlanAuthorizationState(plan), {
    planId: plan.content.planId,
    planHash: plan.hash,
    operationKind: plan.content.operationKind,
    decision,
  }, planContext(plan), NOW + 1).state
}

function taskPlan(): ImmutablePlan {
  const base = planFor({
    candidateRef: skill.candidateRef,
    operationKind: 'install',
    scopeKey: 'user',
    profileId: 'web',
    targetKey: null,
    configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
  })
  return createImmutablePlan({
    ...base.content,
    origin: 'task',
    planId: 'plan:task:skill',
    intentId: 'intent:task:skill',
    idempotencyKey: 'idempotency:task:skill',
  })
}

function receipt(operationId: string, targetKey: string, outcome: 'committed' | 'rolled-back' = 'committed'): OperationReceipt {
  const body = {
    schemaVersion: 1 as const,
    operationId,
    planId: `plan:${operationId}`,
    planHash: digest(`plan:${operationId}`),
    operationKind: 'install' as const,
    managedObject: 'artifact' as const,
    externalRuntimeAction: 'download' as const,
    runtimeBinding: null,
    planEvidence: {
      origin: 'store' as const,
      candidateRef: skill.candidateRef,
      extensionKind: 'skill' as const,
      extensionId: skill.name,
      artifactRevision: skill.artifact.version,
      artifactIntegrity: skill.artifact.integrity,
      artifactUrl: skill.artifact.acquisitionUrl,
      artifactSizeBytes: skill.artifact.sizeBytes,
      desiredState: 'enabled' as const,
      ownerKey: 'skills',
      scopeKey: 'user',
      profileId: 'web',
      idempotencyKey: `idempotency:${operationId}`,
      authorityDigest: digest(`authority:${operationId}`),
      configurationDigest: digest(`configuration:${operationId}`),
      retentionDigest: digest(`retention:${operationId}`),
      reviewEvidence: testReviewEvidence('skill', 'install'),
      mutationDigest: digest(`mutation-plan:${operationId}`),
      verificationDigest: digest(`verification-plan:${operationId}`),
      restartRequired: false,
      fences: {
        catalogRevision: 2,
        inventoryRevision: digest(`inventory:${operationId}`),
        targetRevision: 'target:1',
        ownerRevision: 'owner:1',
        scopeRevision: 'scope:1',
        profileRevision: 'profile:1',
      },
    },
    targetKey,
    outcome,
    beforeDigest: digest(`before:${operationId}`),
    afterDigest: digest(`after:${operationId}:${outcome}`),
    mutationDigests: [digest(`mutation:${operationId}`)],
    verificationDigests: outcome === 'committed' ? [digest(`verification:${operationId}`)] : [],
    evidence: outcome === 'committed' ? {
      checksActuallyRun: testReviewEvidence('skill', 'install').checks,
      mutation: 'proven' as const,
      verification: 'proven' as const,
      rollback: { attempted: false, status: 'not-required' as const },
      restart: { required: false, status: 'not-required' as const },
      recovery: { attempts: 0, status: 'not-required' as const },
      notProven: [],
    } : {
      checksActuallyRun: testReviewEvidence('skill', 'install').checks,
      mutation: 'proven' as const,
      verification: 'not-proven' as const,
      rollback: { attempted: true, status: 'proven' as const },
      restart: { required: false, status: 'not-required' as const },
      recovery: { attempts: 1, status: 'proven' as const },
      notProven: ['verification' as const],
    },
    journalEventCount: 7,
    journalHeadDigest: digest(`journal:${operationId}`),
    issuedAtMs: NOW,
  }
  return { body, digest: canonicalSha256(body) }
}

function managementFixture() {
  let recovered = false
  const inventory = vi.fn(async () => inventoryResponse())
  const verify = vi.fn(async () => inventoryResponse())
  const preview = vi.fn(async (input: StorePreviewInput) => {
    const plan = planFor(input)
    return {
      protocolVersion: 1 as const,
      intentId: plan.content.intentId,
      plan,
      policy: {
        status: 'eligible' as const,
        policyRevision: 'extension-center-p0-policy-v2',
        authorityDigest: plan.content.authorityDigest,
      },
    }
  })
  const decide = vi.fn(async (plan: ImmutablePlan, value: 'approve' | 'reject') => decided(plan, value))
  const configurationOptions = vi.fn(async (input: { candidateRef: string; operationKind: OperationKind; targetKey: string | null; scopeKey: string; profileId: string }) => ({
    protocolVersion: 1 as const,
    options: input.candidateRef.startsWith('mcp:') ? [{
      candidateRef: input.candidateRef,
      runtimeRef: 'runtime:filesystem-mcp-1.3.0',
      version: '1.3.0',
      transport: 'stdio' as const,
      executablePath: '/opt/dsh/bin/filesystem-mcp',
      fixedArgs: ['--stdio'],
      workingDirectory: '/opt/dsh',
    }] : [],
    currentConfiguration: input.targetKey === null ? null : input.candidateRef === plugin.candidateRef ? {
      freshCacheMs: 900000,
      staleCacheMs: 86400000,
      fetchTimeoutMs: 5000,
      maxCatalogBytes: 8388608,
      maxCatalogEntries: 5000,
      maxTaskChars: 2000,
      maxResults: 8,
      maxCurrentMatches: 8,
      maxMatchedTerms: 12,
      maxDescriptionChars: 600,
    } : { modelInvocable: true, userInvocable: true, projectRoot: null },
  }))
  const taskApprovals = vi.fn(async () => ({ protocolVersion: 1 as const, approvals: [], configurations: [] }))
  const taskAttempts = vi.fn(async () => ({ protocolVersion: 1 as const, attempts: [] }))
  const selectTaskCandidate = vi.fn()
  const retryOriginalTask = vi.fn()
  const cancelTaskAttempt = vi.fn()
  const configureTask = vi.fn(async (input: {
    resolutionId: string
    candidateRef: string
    continuationId: string
    configuration: RpcJson
  }) => {
    const base = planFor({
      candidateRef: input.candidateRef,
      operationKind: 'install',
      scopeKey: 'profile:web',
      profileId: 'web',
      targetKey: null,
      configuration: input.configuration,
    })
    const task = createImmutablePlan({
      ...base.content,
      origin: 'task',
      planId: `plan:${input.resolutionId}`,
      intentId: `intent:${input.resolutionId}`,
      idempotencyKey: `idempotency:${input.resolutionId}`,
    })
    return {
      protocolVersion: 1 as const,
      resolutionId: input.resolutionId,
      intentId: task.content.intentId,
      plan: task,
      policy: {
        status: 'eligible' as const,
        policyRevision: 'extension-center-p0-policy-v2',
        authorityDigest: task.content.authorityDigest,
      },
    }
  })
  const plan = vi.fn(async () => null)
  const execute = vi.fn(async (planHash: string) => {
    const operationId = `operation:${planHash.slice(-10)}`
    return {
      protocolVersion: 1 as const,
      operationId,
      status: 'committed' as const,
      receipt: receipt(operationId, `target:${planHash.slice(-8)}`),
    }
  })
  const targetKey = inventoryResponse().inventory.rows[0]!.targetKey
  const operations = vi.fn(async () => ({
    protocolVersion: 1 as const,
    operations: [
      { operationId: 'operation:committed', targetKey, phase: 'committed' as const, operationKind: 'install' as const, lastAtMs: NOW },
      { operationId: 'operation:recovery', targetKey, phase: recovered ? 'rolled-back' as const : 'recovery-required' as const, operationKind: 'update' as const, lastAtMs: NOW + 1 },
    ],
  }))
  const committedReceipt = receipt('operation:committed', targetKey)
  const recoveredReceipt = receipt('operation:recovery', targetKey, 'rolled-back')
  const receipts = vi.fn(async () => ({
    protocolVersion: 1 as const,
    receipts: [
      { operationId: 'operation:committed', targetKey, receipt: committedReceipt },
      ...(recovered ? [{ operationId: 'operation:recovery', targetKey, receipt: recoveredReceipt }] : []),
    ],
  }))
  const recover = vi.fn(async (operationId: string) => {
    expect(operationId).toBe('operation:recovery')
    recovered = true
    return {
      protocolVersion: 1 as const,
      operationId,
      status: 'rolled-back' as const,
      receipt: recoveredReceipt,
    }
  })
  const client: ExtensionManagementClient = {
    inventory, verify, preview, configurationOptions, taskApprovals, configureTask, taskAttempts,
    selectTaskCandidate, retryOriginalTask, cancelTaskAttempt, plan, decide, execute, recover, operations, receipts,
  }
  return {
    client, inventory, verify, preview, configurationOptions, taskApprovals, configureTask, taskAttempts,
    selectTaskCandidate, retryOriginalTask, cancelTaskAttempt, plan, decide, execute, recover, operations, receipts,
    committedReceipt, recoveredReceipt,
  }
}

function renderCenter(management: ExtensionManagementClient, snapshot = catalogSnapshot) {
  const instance = createExtensionCenterStore().create()
  const catalog: ExtensionCatalogClient = { list: async () => snapshot }
  const t = (key: ExtensionCenterKey): string => en[key]
  function Harness() {
    const useStore = <Selected,>(selector: (state: ReturnType<typeof instance.getSnapshot>) => Selected): Selected =>
      useSyncExternalStore(instance.subscribe, () => selector(instance.getSnapshot()))
    const shared = { actions: instance.actions, useStore, t }
    return (
      <>
        <ExtensionCenterTrigger {...({ ...shared, wide: true } as ExtensionCenterTriggerProps)} />
        <ExtensionCenterOverlay {...({
          ...shared,
          catalog,
          management,
          managementContext: { defaultScopeKey: 'profile:web', profileId: 'web' },
        } as ExtensionCenterOverlayProps)} />
      </>
    )
  }
  return render(<Harness />)
}

function openStore() {
  fireEvent.click(screen.getByRole('button', { name: 'Extensions' }))
  return screen.getByRole('dialog', { name: 'Extension Store' })
}

describe('full P0 Browser management flow', () => {
  it('requires explicit scope, previews exact authority, and approves before lifecycle execution', async () => {
    const fixture = managementFixture()
    renderCenter(fixture.client)
    const dialog = openStore()
    const store = within(dialog).getByRole('tabpanel', { name: 'Store' })
    const card = (await within(store).findByRole('heading', { name: 'Documentation Writer' })).closest('article')!
    const review = within(card).getByRole('button', { name: 'Review install' })
    expect(review).toBeDisabled()
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.decide).not.toHaveBeenCalled()
    expect(fixture.execute).not.toHaveBeenCalled()

    fireEvent.change(within(card).getByRole('combobox', { name: 'Target scope' }), { target: { value: 'user' } })
    expect(review).toBeEnabled()
    fireEvent.click(review)
    await within(store).findByRole('heading', { name: 'Skill target settings' })
    fireEvent.click(within(store).getByRole('button', { name: 'Save and review' }))
    const plan = await within(store).findByRole('heading', { name: 'Review exact lifecycle plan' })
    const planSurface = plan.closest('section')!
    await waitFor(() => { expect(planSurface).toHaveFocus() })
    expect(fixture.preview).toHaveBeenCalledWith({
      candidateRef: skill.candidateRef,
      operationKind: 'install',
      scopeKey: 'user',
      profileId: 'web',
      targetKey: null,
      configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
    }, expect.any(AbortSignal))
    expect(within(planSurface).getByText(skill.artifact.version)).toBeVisible()
    expect(within(planSurface).getByText(skill.artifact.integrity)).toBeVisible()
    expect(within(planSurface).getAllByText(/No restart declared/).length).toBeGreaterThan(0)
    expect(within(planSurface).getByText(/retain the pinned Skill file/)).toBeVisible()
    expect(within(planSurface).getByText(/model-context/)).toBeVisible()
    expect(fixture.decide).not.toHaveBeenCalled()
    expect(fixture.execute).not.toHaveBeenCalled()
    expect(within(store).queryByRole('button', { name: 'Enable' })).toBeNull()
    expect(within(store).queryByRole('button', { name: 'Disable' })).toBeNull()
    expect(within(store).queryByRole('button', { name: 'Purge retained data' })).toBeNull()

    fireEvent.click(within(planSurface).getByRole('button', { name: 'Approve exact plan' }))
    await within(planSurface).findByText('Lifecycle operation finished')
    expect(fixture.decide).toHaveBeenCalledTimes(1)
    expect(fixture.decide.mock.calls[0]?.[1]).toBe('approve')
    expect(fixture.execute).toHaveBeenCalledTimes(1)
    expect(fixture.execute.mock.invocationCallOrder[0]).toBeGreaterThan(fixture.decide.mock.invocationCallOrder[0]!)
    fireEvent.click(within(planSurface).getByRole('button', { name: 'Close plan review' }))
    await waitFor(() => { expect(review).toHaveFocus() })
  })

  it('requires a Host-provisioned MCP runtime and sends only the typed connection configuration', async () => {
    const missing = managementFixture()
    missing.configurationOptions.mockImplementation(async input => ({
      protocolVersion: 1,
      options: input.candidateRef === mcp.candidateRef ? [] : [],
      currentConfiguration: null,
    }))
    const missingView = renderCenter(missing.client)
    let store = within(openStore()).getByRole('tabpanel', { name: 'Store' })
    let card = (await within(store).findByRole('heading', { name: mcp.displayName.en })).closest('article')!
    const unavailable = within(card).getByRole('button', { name: 'Acquire unavailable' })
    await waitFor(() => { expect(unavailable).toBeDisabled() })
    expect(unavailable).toHaveAttribute('title', 'No admitted runtime is provisioned')
    expect(missing.preview).not.toHaveBeenCalled()
    missingView.unmount()

    const fixture = managementFixture()
    renderCenter(fixture.client)
    store = within(openStore()).getByRole('tabpanel', { name: 'Store' })
    card = (await within(store).findByRole('heading', { name: mcp.displayName.en })).closest('article')!
    const scope = within(card).getByRole('combobox', { name: 'Target scope' })
    await waitFor(() => { expect(scope).toBeEnabled() })
    fireEvent.change(scope, { target: { value: 'profile:web' } })
    const add = within(card).getByRole('button', { name: 'Add connection' })
    expect(add).toBeEnabled()
    fireEvent.click(add)
    const draft = (await within(store).findByRole('heading', { name: 'MCP connection settings' })).closest('section')!
    expect(within(draft).getByRole('combobox', { name: 'Host-provisioned runtime' })).toHaveValue('runtime:filesystem-mcp-1.3.0')
    expect(within(draft).getByText('/opt/dsh/bin/filesystem-mcp')).toBeVisible()
    const roots = within(draft).getByRole('textbox', { name: /Allowed filesystem roots/ })
    fireEvent.change(roots, { target: { value: '/workspace\nrelative-root' } })
    fireEvent.click(within(draft).getByRole('button', { name: 'Save and review' }))
    expect(within(draft).getByRole('alert')).toHaveTextContent('roots')
    expect(fixture.preview).not.toHaveBeenCalledWith(expect.objectContaining({ candidateRef: mcp.candidateRef }), expect.anything())

    fireEvent.change(roots, { target: { value: '/workspace\n/tmp/data' } })
    fireEvent.click(within(draft).getByRole('button', { name: 'Save and review' }))
    const planSurface = (await within(store).findByRole('heading', { name: 'Review exact lifecycle plan' })).closest('section')!
    expect(within(planSurface).getByText('connection')).toBeVisible()
    expect(within(planSurface).getByText('none')).toBeVisible()
    expect(within(planSurface).getByText('runtime:filesystem-mcp-1.3.0')).toBeVisible()
    expect(within(planSurface).getByText(digest('runtime:filesystem-mcp-1.3.0'))).toBeVisible()
    expect(within(planSurface).getByText(/No external runtime download/)).toBeVisible()
    expect(fixture.preview).toHaveBeenCalledWith({
      candidateRef: mcp.candidateRef,
      operationKind: 'install',
      scopeKey: 'profile:web',
      profileId: 'web',
      targetKey: null,
      configuration: {
        transport: 'stdio',
        connectionId: 'filesystem',
        runtimeRef: 'runtime:filesystem-mcp-1.3.0',
        roots: ['/workspace', '/tmp/data'],
        toolCallTimeoutMs: 30000,
        reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5000, maxAttempts: 8 },
      },
    }, expect.any(AbortSignal))
  })

  it('keeps project-scoped Skill acquisition read-only until a workspace and Agent selector exists', async () => {
    const fixture = managementFixture()
    renderCenter(fixture.client)
    const store = within(openStore()).getByRole('tabpanel', { name: 'Store' })
    const card = (await within(store).findByRole('heading', { name: 'Documentation Writer' })).closest('article')!
    const projectScope = within(card).getByRole('combobox', { name: 'Target scope' })
    expect(within(projectScope).getByRole('option', {
      name: 'Project (read-only until a workspace and Agent selector is available)',
    })).toBeDisabled()
    expect(projectScope).toHaveValue('')
    expect(within(card).getByRole('button', { name: 'Review install' })).toBeDisabled()
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.decide).not.toHaveBeenCalled()
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('creates only a new target from Store and routes the rest of the lifecycle through Installed', async () => {
    const fixture = managementFixture()
    renderCenter(fixture.client)
    const store = within(openStore()).getByRole('tabpanel', { name: 'Store' })
    const card = (await within(store).findByRole('heading', { name: plugin.displayName.en })).closest('article')!
    fireEvent.change(within(card).getByRole('combobox', { name: 'Target scope' }), {
      target: { value: plugin.scopes[0] },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'View details' }))
    const detail = (await within(store).findByRole('heading', { name: plugin.displayName.en, level: 3 })).closest('section')!
    expect(within(detail).getByText(/Store creates new managed targets/)).toBeVisible()
    expect(within(detail).getByRole('button', { name: 'Install' })).toBeEnabled()
    for (const forbidden of ['Configure', 'Update', 'Uninstall', 'Restore', 'Enable', 'Disable', 'Purge retained data']) {
      expect(within(detail).queryByRole('button', { name: forbidden })).toBeNull()
    }

    fireEvent.click(within(detail).getByRole('button', { name: 'Install' }))
    await within(store).findByRole('heading', { name: 'Review exact lifecycle plan' })
    expect(fixture.preview).toHaveBeenCalledWith({
      candidateRef: plugin.candidateRef,
      operationKind: 'install',
      scopeKey: plugin.scopes[0],
      profileId: 'web',
      targetKey: null,
      configuration: {},
    }, expect.any(AbortSignal))
  })

  it('opens the typed management draft for the exact resolver 0.1.1 candidate', async () => {
    const fixture = managementFixture()
    const [, next] = CAPABILITY_RESOLVER_CANDIDATES
    const nextResolver = {
      ...plugin,
      candidateRef: next.candidateRef,
      artifact: {
        ...plugin.artifact,
        version: next.version,
        integrity: next.integrity,
        sizeBytes: next.sizeBytes,
      },
    }
    fixture.inventory.mockResolvedValue(inventoryResponse(hostCapabilities, next.candidateRef))
    fixture.configurationOptions.mockResolvedValue({
      protocolVersion: 1,
      options: [],
      currentConfiguration: {},
    })
    renderCenter(fixture.client, {
      ...catalogSnapshot,
      entries: catalogSnapshot.entries.map(entry => entry === plugin ? nextResolver : entry),
    })
    const dialog = openStore()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Installed' }))
    const installed = within(dialog).getByRole('tabpanel', { name: 'Installed' })
    const card = (await within(installed).findByRole('heading', { name: plugin.name })).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Configure' }))

    await waitFor(() => { expect(within(card).getAllByRole('spinbutton')).toHaveLength(10) })
    expect(fixture.configurationOptions).toHaveBeenCalledWith({
      candidateRef: next.candidateRef,
      operationKind: 'configure',
      targetKey: pluginTargetKey,
      scopeKey: 'profile:web',
      profileId: 'web',
    }, expect.any(AbortSignal))
  })

  it('carries the installed resolver configuration into the exact 0.1.1 update preview', async () => {
    const fixture = managementFixture()
    const [, next] = CAPABILITY_RESOLVER_CANDIDATES
    const nextResolver = {
      ...plugin,
      candidateRef: next.candidateRef,
      artifact: {
        ...plugin.artifact,
        version: next.version,
        integrity: next.integrity,
        sizeBytes: next.sizeBytes,
      },
    }
    const currentConfiguration = {
      freshCacheMs: 900000,
      staleCacheMs: 86400000,
      fetchTimeoutMs: 5000,
      maxCatalogBytes: 8388608,
      maxCatalogEntries: 5000,
      maxTaskChars: 2000,
      maxResults: 8,
      maxCurrentMatches: 8,
      maxMatchedTerms: 12,
      maxDescriptionChars: 600,
    }
    fixture.inventory.mockResolvedValue(inventoryResponse(hostCapabilities, plugin.candidateRef, {
      status: 'available',
      candidateRef: next.candidateRef,
      revision: next.version,
      integrity: next.integrity,
    }))
    fixture.configurationOptions.mockResolvedValue({
      protocolVersion: 1,
      options: [],
      currentConfiguration,
    })
    fixture.preview.mockRejectedValue(new Error('stop after exact update request'))
    renderCenter(fixture.client, {
      ...catalogSnapshot,
      entries: [...catalogSnapshot.entries, nextResolver],
    })
    const dialog = openStore()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Installed' }))
    const installed = within(dialog).getByRole('tabpanel', { name: 'Installed' })
    const card = (await within(installed).findByRole('heading', { name: plugin.name })).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Update' }))

    await waitFor(() => {
      expect(fixture.preview).toHaveBeenCalledWith({
        candidateRef: next.candidateRef,
        operationKind: 'update',
        scopeKey: 'profile:web',
        profileId: 'web',
        targetKey: pluginTargetKey,
        configuration: currentConfiguration,
      }, expect.any(AbortSignal))
    })
  })

  it('uses the retained candidate and configuration for active restore', async () => {
    const fixture = managementFixture()
    const [, next] = CAPABILITY_RESOLVER_CANDIDATES
    const retainedConfiguration = {
      freshCacheMs: 5_000,
      staleCacheMs: 30_000,
      fetchTimeoutMs: 10_000,
      maxCatalogBytes: 1_048_576,
      maxCatalogEntries: 2_000,
      maxTaskChars: 4_000,
      maxResults: 5,
      maxCurrentMatches: 10,
      maxMatchedTerms: 10,
      maxDescriptionChars: 500,
    }
    fixture.inventory.mockResolvedValue(inventoryResponse(
      hostCapabilities,
      next.candidateRef,
      { status: 'none' },
      {
        status: 'available',
        candidateRef: plugin.candidateRef,
        revision: plugin.artifact.version,
        integrity: plugin.artifact.integrity,
      },
    ))
    fixture.configurationOptions.mockResolvedValue({
      protocolVersion: 1,
      options: [],
      currentConfiguration: retainedConfiguration,
    })
    fixture.preview.mockRejectedValue(new Error('stop after exact restore request'))
    renderCenter(fixture.client)
    const dialog = openStore()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Installed' }))
    const installed = within(dialog).getByRole('tabpanel', { name: 'Installed' })
    const card = (await within(installed).findByRole('heading', { name: plugin.name })).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Restore' }))

    await waitFor(() => {
      expect(fixture.configurationOptions).toHaveBeenCalledWith({
        candidateRef: plugin.candidateRef,
        operationKind: 'restore',
        targetKey: pluginTargetKey,
        scopeKey: 'profile:web',
        profileId: 'web',
      }, expect.any(AbortSignal))
      expect(fixture.preview).toHaveBeenCalledWith({
        candidateRef: plugin.candidateRef,
        operationKind: 'restore',
        scopeKey: 'profile:web',
        profileId: 'web',
        targetKey: pluginTargetKey,
        configuration: retainedConfiguration,
      }, expect.any(AbortSignal))
    })
  })

  it('does not fall back to another configuration form for an unknown resolver version', async () => {
    const fixture = managementFixture()
    const unknown = 'plugin:dsh-capability-resolver@0.1.2'
    fixture.inventory.mockResolvedValue(inventoryResponse(hostCapabilities, unknown))
    fixture.configurationOptions.mockResolvedValue({
      protocolVersion: 1,
      options: [],
      currentConfiguration: {},
    })
    renderCenter(fixture.client)
    const dialog = openStore()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Installed' }))
    const installed = within(dialog).getByRole('tabpanel', { name: 'Installed' })
    const card = (await within(installed).findByRole('heading', { name: plugin.name })).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: 'Configure' }))

    expect(await within(card).findByRole('alert')).toHaveTextContent('Management unavailable')
    expect(within(card).queryByRole('spinbutton')).toBeNull()
    expect(within(card).queryByRole('checkbox')).toBeNull()
  })

  it('retries preview safely but never repeats an uncertain decision grant', async () => {
    const fixture = managementFixture()
    let previewAttempt = 0
    fixture.preview.mockImplementation(async (input) => {
      previewAttempt += 1
      if (previewAttempt === 1) throw new Error('preview transport failed')
      const plan = planFor(input)
      return {
        protocolVersion: 1 as const,
        intentId: plan.content.intentId,
        plan,
        policy: {
          status: 'eligible' as const,
          policyRevision: 'extension-center-p0-policy-v2',
          authorityDigest: plan.content.authorityDigest,
        },
      }
    })
    fixture.decide.mockRejectedValue(new Error('decision response lost'))
    renderCenter(fixture.client)
    const store = within(openStore()).getByRole('tabpanel', { name: 'Store' })
    const card = (await within(store).findByRole('heading', { name: 'Documentation Writer' })).closest('article')!
    fireEvent.change(within(card).getByRole('combobox', { name: 'Target scope' }), { target: { value: 'user' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Review install' }))
    await within(store).findByRole('heading', { name: 'Skill target settings' })
    fireEvent.click(within(store).getByRole('button', { name: 'Save and review' }))
    expect(await within(store).findByText('Plan preview unavailable')).toBeVisible()
    expect(fixture.preview).toHaveBeenCalledTimes(1)
    fireEvent.click(within(store).getByRole('button', { name: 'Retry preview' }))
    const review = (await within(store).findByRole('heading', { name: 'Review exact lifecycle plan' })).closest('section')!
    expect(fixture.preview).toHaveBeenCalledTimes(2)

    const approve = within(review).getByRole('button', { name: 'Approve exact plan' })
    fireEvent.click(approve)
    expect(await within(review).findByText('Decision result requires reconciliation')).toBeVisible()
    expect(approve).toBeDisabled()
    expect(within(review).getByRole('button', { name: 'Reject plan' })).toBeDisabled()
    fireEvent.click(approve)
    expect(fixture.decide).toHaveBeenCalledTimes(1)
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('allows a second decision only after exact reconciliation proves the first was not recorded', async () => {
    const fixture = managementFixture()
    const expected = planFor({
      candidateRef: skill.candidateRef,
      operationKind: 'install',
      scopeKey: 'user',
      profileId: 'web',
      targetKey: null,
      configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
    })
    fixture.decide.mockRejectedValueOnce(new Error('decision response lost'))
    fixture.plan.mockResolvedValueOnce(createPlanAuthorizationState(expected))
    renderCenter(fixture.client)
    const store = within(openStore()).getByRole('tabpanel', { name: 'Store' })
    const card = (await within(store).findByRole('heading', { name: 'Documentation Writer' })).closest('article')!
    fireEvent.change(within(card).getByRole('combobox', { name: 'Target scope' }), { target: { value: 'user' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Review install' }))
    await within(store).findByRole('heading', { name: 'Skill target settings' })
    fireEvent.click(within(store).getByRole('button', { name: 'Save and review' }))
    const review = (await within(store).findByRole('heading', { name: 'Review exact lifecycle plan' })).closest('section')!

    fireEvent.click(within(review).getByRole('button', { name: 'Approve exact plan' }))
    expect(await within(review).findByText('Decision result requires reconciliation')).toBeVisible()
    expect(fixture.plan).toHaveBeenCalledWith(expected.hash, expect.any(AbortSignal))
    const approve = within(review).getByRole('button', { name: 'Approve exact plan' })
    expect(approve).toBeEnabled()
    expect(within(review).getByRole('button', { name: 'Reject plan' })).toBeEnabled()

    fireEvent.click(approve)
    await waitFor(() => { expect(fixture.decide).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(fixture.execute).toHaveBeenCalledTimes(1) })
  })

  it('resumes an exactly reconciled approved plan without issuing a second grant', async () => {
    const fixture = managementFixture()
    const expected = planFor({
      candidateRef: skill.candidateRef,
      operationKind: 'install',
      scopeKey: 'user',
      profileId: 'web',
      targetKey: null,
      configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
    })
    fixture.decide.mockRejectedValueOnce(new Error('decision response lost'))
    fixture.plan.mockResolvedValueOnce(decided(expected, 'approve') as Extract<PlanAuthorizationState, { status: 'approved' }>)
    renderCenter(fixture.client)
    const store = within(openStore()).getByRole('tabpanel', { name: 'Store' })
    const card = (await within(store).findByRole('heading', { name: 'Documentation Writer' })).closest('article')!
    fireEvent.change(within(card).getByRole('combobox', { name: 'Target scope' }), { target: { value: 'user' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Review install' }))
    await within(store).findByRole('heading', { name: 'Skill target settings' })
    fireEvent.click(within(store).getByRole('button', { name: 'Save and review' }))
    const review = (await within(store).findByRole('heading', { name: 'Review exact lifecycle plan' })).closest('section')!

    fireEvent.click(within(review).getByRole('button', { name: 'Approve exact plan' }))
    expect(await within(review).findByText('Decision result requires reconciliation')).toBeVisible()
    expect(fixture.decide).toHaveBeenCalledTimes(1)
    expect(fixture.execute).not.toHaveBeenCalled()

    const resume = within(review).getByRole('button', { name: 'Resume approved plan' })
    expect(resume).toBeEnabled()
    fireEvent.click(resume)
    await waitFor(() => { expect(fixture.execute).toHaveBeenCalledWith(expected.hash, expect.any(AbortSignal)) })
    expect(fixture.decide).toHaveBeenCalledTimes(1)
  })

  it('keeps all mutation actions disabled when any writable Host owner is missing', async () => {
    const readOnlyCapabilities: HostCapabilityProjection = {
      ...hostCapabilities,
      skillRegistry: false,
      acquisition: false,
      reason: 'host-capability',
    }
    const fixture = managementFixture()
    const client: ExtensionManagementClient = {
      ...fixture.client,
      inventory: async () => inventoryResponse(readOnlyCapabilities),
    }
    const readOnlyCatalog = catalogListResponse(verifyBootstrapCatalog(NOW), readOnlyCapabilities)
    renderCenter(client, readOnlyCatalog)
    const dialog = openStore()
    const store = within(dialog).getByRole('tabpanel', { name: 'Store' })
    const capability = (await within(store).findByText('Skill registry')).parentElement!
    expect(within(capability).getByText('Missing')).toBeVisible()
    expect(within(store).getAllByRole('button', { name: 'Acquire unavailable' }).length).toBeGreaterThan(0)

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Installed' }))
    const installed = within(dialog).getByRole('tabpanel', { name: 'Installed' })
    const row = (await within(installed).findByRole('heading', { name: skill.name })).closest('article')!
    expect(within(row).getByRole('button', { name: 'Enable' })).toBeDisabled()
    expect(within(row).getByRole('button', { name: 'Purge retained data' })).toBeDisabled()

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Updates' }))
    const updates = within(dialog).getByRole('tabpanel', { name: 'Updates' })
    expect(await within(updates).findByRole('button', { name: 'Update' })).toBeDisabled()

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Activity & Recovery' }))
    const activity = within(dialog).getByRole('tabpanel', { name: 'Activity & Recovery' })
    expect(await within(activity).findByRole('button', { name: 'Retry exact recovery' })).toBeDisabled()
    expect(fixture.preview).not.toHaveBeenCalled()
  })

  it('lets ordinary users inspect Installed and Updates independently for every managed scope', async () => {
    const fixture = managementFixture()
    renderCenter(fixture.client)
    const dialog = openStore()

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Installed' }))
    const installed = within(dialog).getByRole('tabpanel', { name: 'Installed' })
    const installedRow = (await within(installed).findByRole('heading', { name: skill.name })).closest('article')!
    fireEvent.click(within(installedRow).getByRole('button', { name: 'Verify current state' }))
    await waitFor(() => {
      expect(fixture.verify).toHaveBeenCalledWith(
        'profile:web', 'web', installedRow.getAttribute('data-target-key'),
      )
    })
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.decide).not.toHaveBeenCalled()
    expect(fixture.execute).not.toHaveBeenCalled()
    const installedScope = await within(installed).findByRole('combobox', { name: 'Scope' })
    fireEvent.change(installedScope, { target: { value: 'user' } })
    await waitFor(() => {
      expect(fixture.inventory).toHaveBeenLastCalledWith('user', 'web', expect.any(AbortSignal))
    })

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Updates' }))
    const updates = within(dialog).getByRole('tabpanel', { name: 'Updates' })
    const updatesScope = await within(updates).findByRole('combobox', { name: 'Scope' })
    fireEvent.change(updatesScope, { target: { value: 'project' } })
    await waitFor(() => {
      expect(fixture.inventory).toHaveBeenLastCalledWith('project', 'web', expect.any(AbortSignal))
    })
  })

  it('reviews and decides an Agent-created task plan from the approval queue before execution', async () => {
    const fixture = managementFixture()
    const plan = taskPlan()
    fixture.taskApprovals.mockResolvedValue({
      protocolVersion: 1,
      configurations: [],
      approvals: [{
        state: createPlanAuthorizationState(plan),
        configuration: { modelInvocable: true, userInvocable: true, projectRoot: null },
      }],
    })
    renderCenter(fixture.client)
    const dialog = openStore()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Activity & Recovery' }))
    const activity = within(dialog).getByRole('tabpanel', { name: 'Activity & Recovery' })
    expect(await within(activity).findByRole('heading', { name: 'Task acquisition approvals' })).toBeVisible()
    fireEvent.click(within(activity).getByRole('button', { name: 'Review task plan' }))
    const review = (await within(activity).findByRole('heading', { name: 'Review exact lifecycle plan' })).closest('section')!
    expect(within(review).getByText(plan.hash)).toBeVisible()
    expect(within(review).getByText(/projectRoot: null/)).toBeVisible()
    expect(fixture.preview).not.toHaveBeenCalled()
    fireEvent.click(within(review).getByRole('button', { name: 'Approve exact plan' }))
    await waitFor(() => { expect(fixture.decide).toHaveBeenCalledWith(plan, 'approve', expect.any(AbortSignal)) })
    await waitFor(() => { expect(fixture.execute).toHaveBeenCalledWith(plan.hash, expect.any(AbortSignal)) })
    expect(fixture.execute.mock.invocationCallOrder[0]).toBeGreaterThan(fixture.decide.mock.invocationCallOrder[0]!)
  })

  it('shows the Host continuation lifecycle separately and removes Cancel after a real cancellation', async () => {
    const fixture = managementFixture()
    const parentId = 'task-attempt:00000000-0000-4000-8000-000000000731'
    const retryId = 'task-attempt:00000000-0000-4000-8000-000000000732'
    const continuationId = '00000000-0000-4000-8000-000000000733'
    const parent = {
      taskAttemptId: parentId,
      parentAttemptId: null,
      trigger: 'model' as const,
      sessionId: 'session:retry',
      originalMessageId: 'message:retry',
      createdAtMs: NOW,
      expiresAtMs: NOW + 60_000,
      updatedAtMs: NOW + 1,
      phase: 'resolving' as const,
      outcome: 'management-required' as const,
      reason: 'managed-extension-requires-enable',
      choice: null,
      management: {
        extensionRef: 'extension-ref:00000000-0000-4000-8000-000000000734',
        action: 'enable' as const,
      },
      acquisition: null,
      retryContinuation: null,
    }
    const retry = (state: 'pending' | 'canceled') => ({
      ...parent,
      taskAttemptId: retryId,
      parentAttemptId: parentId,
      trigger: 'retry-original' as const,
      createdAtMs: NOW + 2,
      updatedAtMs: NOW + 3,
      outcome: 'use-existing' as const,
      reason: 'existing-capability-visible',
      management: null,
      retryContinuation: { continuationId, state },
    })
    let canceled = false
    fixture.taskAttempts.mockImplementation(async () => ({
      protocolVersion: 1,
      attempts: [parent, retry(canceled ? 'canceled' : 'pending')],
    }))
    fixture.cancelTaskAttempt.mockImplementation(async () => {
      canceled = true
      return { protocolVersion: 1, attempt: retry('canceled') }
    })

    renderCenter(fixture.client)
    const dialog = openStore()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Activity & Recovery' }))
    const activity = within(dialog).getByRole('tabpanel', { name: 'Activity & Recovery' })
    const pending = await within(activity).findByText('Waiting for capability verification')
    const retryCard = pending.closest('article')!
    expect(retryCard).toHaveAttribute('data-task-outcome', 'use-existing')
    fireEvent.click(within(retryCard).getByRole('button', { name: 'Cancel continuation' }))

    const canceledStatus = await within(activity).findByText('Continuation canceled')
    const canceledCard = canceledStatus.closest('article')!
    expect(canceledCard).toHaveAttribute('data-task-outcome', 'use-existing')
    expect(within(canceledCard).queryByRole('button', { name: 'Cancel continuation' })).toBeNull()
    expect(fixture.cancelTaskAttempt).toHaveBeenCalledWith(retryId, expect.any(AbortSignal))
    expect(zh['taskAttempt.retryContinuation.canceled']).toBe('续跑已取消')
  })

  it('turns an Agent-found MCP candidate into a plan only after trusted typed configuration', async () => {
    const fixture = managementFixture()
    const resolutionId = 'resolution:00000000-0000-4000-8000-000000000451'
    const continuationId = '00000000-0000-4000-8000-000000000452'
    let configured: Readonly<{ plan: ImmutablePlan; configuration: RpcJson }> | undefined
    fixture.taskApprovals.mockImplementation(async () => ({
      protocolVersion: 1,
      configurations: configured === undefined ? [{
        resolutionId,
        candidateRef: mcp.candidateRef,
        continuationId,
        extensionKind: 'mcp' as const,
        scopeKey: 'profile:web',
        profileId: 'web',
        createdAtMs: NOW,
        expiresAtMs: NOW + 60_000,
      }] : [],
      approvals: configured === undefined ? [] : [{
        state: createPlanAuthorizationState(configured.plan),
        configuration: configured.configuration,
      }],
    }))
    fixture.configureTask.mockImplementation(async (input) => {
      const base = planFor({
        candidateRef: input.candidateRef,
        operationKind: 'install',
        scopeKey: 'profile:web',
        profileId: 'web',
        targetKey: null,
        configuration: input.configuration,
      })
      const plan = createImmutablePlan({
        ...base.content,
        origin: 'task',
        planId: `plan:${resolutionId}`,
        intentId: `intent:${resolutionId}`,
        idempotencyKey: `idempotency:${resolutionId}`,
      })
      configured = { plan, configuration: input.configuration }
      return {
        protocolVersion: 1,
        resolutionId,
        intentId: plan.content.intentId,
        plan,
        policy: {
          status: 'eligible',
          policyRevision: 'extension-center-p0-policy-v2',
          authorityDigest: plan.content.authorityDigest,
        },
      }
    })

    renderCenter(fixture.client)
    const dialog = openStore()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Activity & Recovery' }))
    const activity = within(dialog).getByRole('tabpanel', { name: 'Activity & Recovery' })
    expect(await within(activity).findByRole('heading', { name: 'Task configuration requests' })).toBeVisible()
    fireEvent.click(within(activity).getByRole('button', { name: 'Configure task candidate' }))
    const draft = (await within(activity).findByRole('heading', { name: 'MCP connection settings' })).closest('section')!
    fireEvent.change(within(draft).getByRole('textbox', { name: /Allowed filesystem roots/ }), { target: { value: '/workspace/task' } })
    fireEvent.click(within(draft).getByRole('button', { name: 'Save and review' }))

    const review = (await within(activity).findByRole('heading', { name: 'Review exact lifecycle plan' })).closest('section')!
    expect(fixture.configureTask).toHaveBeenCalledWith({
      resolutionId,
      candidateRef: mcp.candidateRef,
      continuationId,
      configuration: {
        transport: 'stdio',
        connectionId: 'filesystem',
        runtimeRef: 'runtime:filesystem-mcp-1.3.0',
        roots: ['/workspace/task'],
        toolCallTimeoutMs: 30_000,
        reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 5_000, maxAttempts: 8 },
      },
    })
    expect(within(review).getByText('connection')).toBeVisible()
    expect(within(review).getByText(/No external runtime download/)).toBeVisible()
    expect(fixture.decide).not.toHaveBeenCalled()
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('shows independent state dimensions, staged Configure, exact Updates, receipts, and exact recovery retry', async () => {
    const fixture = managementFixture()
    renderCenter(fixture.client)
    const dialog = openStore()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Installed' }))
    const installed = within(dialog).getByRole('tabpanel', { name: 'Installed' })
    const extension = await within(installed).findByRole('heading', { name: skill.name })
    const card = extension.closest('article')!
    for (const label of ['Desired', 'Materialized', 'Effective', 'Agent visibility', 'Verification', 'Rollback', 'Ownership']) {
      expect(within(card).getByText(label)).toBeVisible()
    }
    for (const action of ['Install', 'Configure', 'Update', 'Enable', 'Disable', 'Uninstall', 'Restore', 'Purge retained data']) {
      expect(within(card).getByRole('button', { name: action })).toBeVisible()
    }

    const pluginCard = (within(installed).getByRole('heading', { name: plugin.name })).closest('article')!
    fireEvent.click(within(pluginCard).getByRole('button', { name: 'Configure' }))
    expect(within(pluginCard).queryByRole('textbox', { name: 'Configuration JSON' })).toBeNull()
    await waitFor(() => { expect(within(pluginCard).getAllByRole('spinbutton')).toHaveLength(10) })
    fireEvent.click(within(pluginCard).getByRole('button', { name: 'Discard draft' }))
    expect(within(pluginCard).queryByRole('spinbutton')).toBeNull()
    expect(fixture.preview).not.toHaveBeenCalled()
    fireEvent.click(within(pluginCard).getByRole('button', { name: 'Configure' }))
    await waitFor(() => { expect(within(pluginCard).getAllByRole('spinbutton')).toHaveLength(10) })
    const fresh = within(pluginCard).getByRole('spinbutton', { name: /freshCacheMs/ })
    const stale = within(pluginCard).getByRole('spinbutton', { name: /staleCacheMs/ })
    fireEvent.change(fresh, { target: { value: '5000' } })
    fireEvent.change(stale, { target: { value: '4000' } })
    fireEvent.click(within(pluginCard).getByRole('button', { name: 'Save and review' }))
    expect(within(pluginCard).getByRole('alert')).toHaveTextContent('staleCacheMs')
    expect(fixture.preview).not.toHaveBeenCalled()
    fireEvent.change(stale, { target: { value: '10000' } })
    fireEvent.click(within(pluginCard).getByRole('button', { name: 'Save and review' }))
    const configurePlan = (await within(installed).findByRole('heading', { name: 'Review exact lifecycle plan' })).closest('section')!
    expect(fixture.preview).toHaveBeenCalledWith(expect.objectContaining({
      candidateRef: plugin.candidateRef,
      operationKind: 'configure',
      configuration: {
        freshCacheMs: 5000,
        staleCacheMs: 10000,
        fetchTimeoutMs: 5000,
        maxCatalogBytes: 8388608,
        maxCatalogEntries: 5000,
        maxTaskChars: 2000,
        maxResults: 8,
        maxCurrentMatches: 8,
        maxMatchedTerms: 12,
        maxDescriptionChars: 600,
      },
      scopeKey: 'profile:web', profileId: 'web', targetKey: pluginTargetKey,
    }), expect.any(AbortSignal))
    expect(within(configurePlan).getByText(/\+ freshCacheMs: 5000/)).toBeVisible()
    const configDiff = within(configurePlan).getByRole('heading', { name: 'Staged configuration diff' }).closest('section')!
    await waitFor(() => { expect(within(configDiff).getByText(/^sha256:/)).toBeVisible() })

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Updates' }))
    const updates = within(dialog).getByRole('tabpanel', { name: 'Updates' })
    expect(await within(updates).findByText(`${skill.artifact.version}+admitted.2`)).toBeVisible()
    expect(within(updates).getByText(skill.artifact.integrity)).toBeVisible()
    const updateButton = within(updates).getByRole('button', { name: 'Update' })
    expect(updateButton).toBeEnabled()
    fireEvent.click(updateButton)
    const updateReview = (await within(updates).findByRole('heading', { name: 'Review exact lifecycle plan' })).closest('section')!
    expect(fixture.preview).toHaveBeenLastCalledWith(expect.objectContaining({
      operationKind: 'update', targetKey: skillTargetKey,
    }), expect.any(AbortSignal))
    expect(within(updateReview).getByText('Exact candidate disclosure unavailable')).toBeVisible()
    expect(within(updateReview).getByRole('button', { name: 'Approve exact plan' })).toBeDisabled()

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Activity & Recovery' }))
    const activity = within(dialog).getByRole('tabpanel', { name: 'Activity & Recovery' })
    expect(await within(activity).findByText(fixture.committedReceipt.digest)).toBeVisible()
    for (const label of [
      'Source', 'Version', 'Integrity', 'Scope / Profile', 'Configuration digest', 'Authority digest',
      'Retention disclosure digest', 'Mutation evidence', 'Verification evidence', 'Rollback evidence',
      'Restart evidence', 'Recovery evidence', 'Not proven',
    ]) expect(within(activity).getByText(label)).toBeVisible()
    expect(within(activity).getByText(fixture.committedReceipt.body.planEvidence.configurationDigest)).toBeVisible()
    expect(within(activity).getByText(fixture.committedReceipt.body.planEvidence.retentionDigest)).toBeVisible()
    expect(within(activity).getByText('Recovery required')).toBeVisible()
    const recover = within(activity).getByRole('button', { name: 'Retry exact recovery' })
    expect(recover).toBeEnabled()
    fireEvent.click(recover)
    await waitFor(() => { expect(fixture.recover).toHaveBeenCalledWith('operation:recovery', expect.any(AbortSignal)) })
    expect(await within(activity).findByText(fixture.recoveredReceipt.digest)).toBeVisible()
    expect(within(activity).queryByRole('button', { name: 'Retry exact recovery' })).toBeNull()
    expect(fixture.preview).not.toHaveBeenCalledWith(expect.objectContaining({ operationKind: 'restore' }), expect.anything())
  })
})
