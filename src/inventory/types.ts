import type { Sha256Digest } from '../domain/index.ts'
import type { DesiredState, ManagedExtensionKind, OperationKind } from '../plans/index.ts'

/** Material controlled by DSH management owners. */
export type MaterializedState = 'absent' | 'installed' | 'configured'

/** Runtime state proved by the extension's authoritative consumer. */
export type EffectiveState =
  | 'inactive'
  | 'restart-required'
  | 'starting'
  | 'active'
  | 'degraded'
  | 'activation-failed'
  | 'unknown'

/** Visibility in one exact Agent observation scope. */
export type AgentVisibility = 'visible' | 'not-visible' | 'unknown'

/** Highest evidence level that has actually completed. */
export type VerificationLevel = 'unverified' | 'structural' | 'runtime' | 'task'

/** Recovery state for the exact managed target. */
export type RollbackState = 'available' | 'running' | 'used' | 'unavailable' | 'failed'

/** Ownership of one inventory row. */
export type InventoryOwnership = 'center' | 'external' | 'system' | 'parent-plugin'

/** Explicit availability of one lifecycle action. */
export type LifecycleActionAvailability =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'external'; readonly reason: string }

/** Every lifecycle operation remains independently visible. */
export type LifecycleActions = Readonly<Record<OperationKind, LifecycleActionAvailability>>

/** Update observation never changes desired or effective state by itself. */
export type UpdateObservation =
  | { readonly status: 'unknown' }
  | { readonly status: 'none' }
  | {
      readonly status: 'available'
      readonly candidateRef: string
      readonly revision: string
      readonly integrity: `sha256:${string}` | `sha512:${string}`
    }

/** Plugin-specific owner evidence. */
export interface PluginInventoryEvidence {
  readonly kind: 'plugin'
  readonly profileGeneration: string | null
  readonly loaderPhase: string | null
  readonly consumerObserved: boolean
  readonly externalRestartObserved: boolean
}

/** MCP-specific owner evidence without inventing unexposed reconnect phases. */
export interface McpInventoryEvidence {
  readonly kind: 'mcp'
  readonly descriptorMatches: boolean
  readonly descriptorDigest: `sha256:${string}` | null
  readonly descriptorRevision: string | null
  readonly transport: 'stdio' | 'http' | null
  readonly desiredEnabled: boolean
  readonly observedLifecycle: 'absent' | 'disabled' | 'starting' | 'ready' | 'degraded' | 'unknown'
  readonly liveDetailAvailable: boolean
  readonly toolGeneration: number | null
  readonly qualifiedTools: readonly string[]
}

/** Skill-specific merged-registry evidence. */
export interface SkillInventoryEvidence {
  readonly kind: 'skill'
  readonly contentRevision: string | null
  readonly catalogComplete: boolean
  readonly winningProvider: string | null
  readonly winningPath: string | null
  readonly definitionLoaded: boolean
  readonly invocation: {
    readonly modelInvocable: boolean
    readonly userInvocable: boolean
  } | null
}

/** Kind-specific evidence emitted by the actual DSH owner. */
export type InventoryEvidence = PluginInventoryEvidence | McpInventoryEvidence | SkillInventoryEvidence

/** One normalized row; state dimensions are deliberately not collapsed into an installed badge. */
export interface InventoryRow {
  readonly schemaVersion: 1
  readonly kind: ManagedExtensionKind
  readonly extensionId: string
  readonly candidateRef: string | null
  readonly targetKey: string
  readonly scopeKey: string
  readonly profileId: string
  readonly ownership: InventoryOwnership
  readonly desired: DesiredState
  readonly materialized: MaterializedState
  readonly effective: EffectiveState
  readonly agentVisibility: AgentVisibility
  readonly verification: VerificationLevel
  readonly rollback: RollbackState
  readonly managedRevision: string
  readonly ownerRevision: string
  readonly configurationRevision: string | null
  readonly observedAtMs: number
  readonly actions: LifecycleActions
  readonly updateObservation: UpdateObservation
  readonly evidence: InventoryEvidence
}

/** Complete normalized inventory observation and its canonical revision. */
export interface InventorySnapshot {
  readonly schemaVersion: 1
  readonly scopeKey: string
  readonly profileId: string
  readonly complete: boolean
  readonly observedAtMs: number
  readonly rows: readonly InventoryRow[]
  readonly revision: Sha256Digest
}

/** Published general Host owner availability. */
export interface InventoryHostCapabilities {
  readonly profileTransaction: boolean
  readonly dynamicMcpConnection: boolean
  readonly durableContinuation: boolean
  readonly skillRegistry: boolean
  readonly toolRegistry: boolean
  readonly loaderObservation: boolean
  readonly acquisition: boolean
}
