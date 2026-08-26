import { readBoundedString, readNonNegativeInteger } from '../domain/codec.ts'
import { failDomain } from '../domain/errors.ts'
import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type {
  AcquisitionIntent,
  AcquisitionIntentCore,
  ResolvedIntentCandidate,
} from './types.ts'

function core(candidate: ResolvedIntentCandidate): AcquisitionIntentCore {
  return immutableJsonClone({
    kind: candidate.kind,
    extensionId: candidate.extensionId,
    candidateRef: candidate.candidateRef,
    artifactRevision: candidate.artifactRevision,
    artifactIntegrity: candidate.artifactIntegrity,
    artifactUrl: candidate.artifactUrl,
    artifactSizeBytes: candidate.artifactSizeBytes,
    scopeKey: candidate.scopeKey,
    profileId: candidate.profileId,
    operationKind: candidate.operationKind,
    desiredState: candidate.desiredState,
    admittedCapabilities: [...candidate.admittedCapabilities].sort(),
    authorityDeltaDigest: candidate.authorityDeltaDigest,
    policyRevision: candidate.policyResult.policyRevision,
    catalogRevision: candidate.catalogRevision,
    inventoryRevision: candidate.inventoryRevision,
  }) as unknown as AcquisitionIntentCore
}

/**
 * Mint one internal acquisition intent after the Host has re-resolved every coordinate.
 * @param input Provenance and exact eligible candidate; browser/model payloads never call this directly.
 * @returns Immutable intent with a canonical entrance-independent mutation core.
 */
export function mintAcquisitionIntent(input: Readonly<{
  intentId: string
  origin: 'store' | 'task'
  idempotencyKey: string
  continuationId?: string
  createdAtMs: number
  expiresAtMs: number
  candidate: ResolvedIntentCandidate
}>): AcquisitionIntent {
  const intentId = readBoundedString(input.intentId, 'intent.intentId')
  const idempotencyKey = readBoundedString(input.idempotencyKey, 'intent.idempotencyKey')
  const createdAtMs = readNonNegativeInteger(input.createdAtMs, 'intent.createdAtMs')
  const expiresAtMs = readNonNegativeInteger(input.expiresAtMs, 'intent.expiresAtMs')
  if (createdAtMs >= expiresAtMs) failDomain('invalid-data', 'intent validity interval is invalid')
  if (input.origin === 'store' && input.continuationId !== undefined) {
    failDomain('invalid-data', 'Store intent cannot carry a continuation')
  }
  if (input.origin === 'task' && input.continuationId === undefined) {
    failDomain('invalid-data', 'task intent requires a continuation')
  }
  const candidateCore = core(input.candidate)
  return immutableJsonClone({
    schemaVersion: 1,
    intentId,
    origin: input.origin,
    idempotencyKey,
    continuationId: input.continuationId === undefined
      ? null
      : readBoundedString(input.continuationId, 'intent.continuationId'),
    createdAtMs,
    expiresAtMs,
    core: candidateCore,
    coreDigest: canonicalSha256(candidateCore),
  }) as unknown as AcquisitionIntent
}
