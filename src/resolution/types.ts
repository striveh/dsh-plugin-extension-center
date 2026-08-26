import type { CatalogEntry } from '../catalog-contract.ts'
import type { Sha256Digest } from '../domain/index.ts'
import type { InventoryRow } from '../inventory/index.ts'
import type { CandidatePolicyResult } from '../policy/index.ts'

/** Bounded task-derived capability requirement used only for local retrieval. */
export interface CapabilityNeed {
  readonly schemaVersion: 1
  readonly outcomeTags: readonly string[]
  readonly inputModalities: readonly ('text' | 'file' | 'image' | 'audio' | 'video' | 'structured-data')[]
  readonly outputModalities: readonly ('text' | 'file' | 'image' | 'audio' | 'video' | 'structured-data')[]
  readonly scopeKey: string
  readonly platform: 'darwin' | 'linux' | 'windows'
  readonly requiredDataAccess: readonly ('network' | 'filesystem-read' | 'filesystem-write' | 'subprocess')[]
  readonly maximumAuthority: readonly ('network' | 'filesystem-read' | 'filesystem-write' | 'subprocess')[]
}

/** One currently Agent-visible capability checked before the catalog. */
export interface ExistingCapability {
  readonly capabilityId: string
  readonly kind: 'tool' | 'skill' | 'plugin'
  readonly outcomeTags: readonly string[]
  readonly dataAccess: readonly string[]
  readonly visible: boolean
  readonly observationComplete: boolean
}

/** Eligible candidate projection containing no executable install text or free-form community instructions. */
export interface RetrievedCandidate {
  readonly candidateRef: string
  readonly kind: CatalogEntry['kind']
  readonly artifactRevision: string
  readonly matchedTags: readonly string[]
  readonly score: number
  readonly authorityFlags: readonly string[]
  readonly scopes: readonly string[]
  readonly policy: Extract<CandidatePolicyResult, { status: 'eligible' }>
}

/** Complete local retrieval result before opaque ids are bound. */
export type CapabilityResolution =
  | {
      readonly decision: 'use-existing'
      readonly needDigest: Sha256Digest
      readonly capabilityId: string
    }
  | {
      readonly decision: 'management-required'
      readonly needDigest: Sha256Digest
      readonly extensionRef: string
      readonly action: 'configure' | 'enable' | 'update' | 'restore'
    }
  | {
      readonly decision: 'acquisition-candidate'
      readonly needDigest: Sha256Digest
      readonly candidate: RetrievedCandidate
    }
  | {
      readonly decision: 'choice-required'
      readonly needDigest: Sha256Digest
      readonly candidates: readonly RetrievedCandidate[]
    }
  | {
      readonly decision: 'no-eligible-candidate' | 'discovery-unavailable'
      readonly needDigest: Sha256Digest
    }

/** Host inputs for existing-first structured and local catalog retrieval. */
export interface CapabilityResolutionInput {
  readonly need: CapabilityNeed
  readonly existing: readonly ExistingCapability[]
  readonly inventory: readonly InventoryRow[]
  readonly inventoryComplete: boolean
  readonly catalog: readonly CatalogEntry[]
  readonly catalogComplete: boolean
  readonly policy: ReadonlyMap<string, CandidatePolicyResult>
  readonly maximumCandidates: number
}
