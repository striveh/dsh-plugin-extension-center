import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import { capabilityResolverCandidate } from '../resolver-candidates.ts'
import type { RpcJson } from '../service/rpc-contract.ts'

const RANGES = Object.freeze({
  freshCacheMs: [1_000, 86_400_000],
  staleCacheMs: [1_000, 604_800_000],
  fetchTimeoutMs: [100, 60_000],
  maxCatalogBytes: [65_536, 33_554_432],
  maxCatalogEntries: [1, 20_000],
  maxTaskChars: [64, 16_000],
  maxResults: [1, 50],
  maxCurrentMatches: [1, 50],
  maxDescriptionChars: [80, 4_000],
  maxMatchedTerms: [1, 50],
} as const)

/** Secret-free exact settings schema and candidate-bound adapter identity shown in review evidence. */
export function pluginConfigurationReview(candidateRef: string, version: string): Readonly<{
  adapterVersion: string
  adapterDigest: `sha256:${string}`
  schemaDigest: `sha256:${string}`
  schema: readonly Readonly<{ field: string; type: 'integer'; minimum: number; maximum: number }>[]
}> {
  const candidate = capabilityResolverCandidate(candidateRef, version)
  if (candidate === null) throw new Error('Plugin version has no exact typed configuration adapter')
  const schema = Object.entries(RANGES).map(([field, range]) => Object.freeze({
    field,
    type: 'integer' as const,
    minimum: range[0],
    maximum: range[1],
  }))
  return Object.freeze({
    adapterVersion: candidate.configurationSchema,
    adapterDigest: canonicalSha256({
      schema: candidate.configurationSchema,
      candidateRef: candidate.candidateRef,
      ranges: RANGES,
    }),
    schemaDigest: canonicalSha256(schema),
    schema: Object.freeze(schema),
  })
}

/** Strict product-owned configuration accepted for the single P0 Plugin candidate. */
export type CapabilityResolverConfiguration = Readonly<Record<keyof typeof RANGES, number>>

/** Validate the complete typed configuration accepted by the exact Plugin adapter. */
export function validateCapabilityResolverConfiguration(value: RpcJson): CapabilityResolverConfiguration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Plugin configuration must be an object')
  }
  const record = value as Readonly<Record<string, RpcJson>>
  const keys = Object.keys(RANGES) as Array<keyof typeof RANGES>
  const actual = Object.keys(record).sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])) {
    throw new Error('Plugin configuration must contain exactly the product-owned fields')
  }
  const output = {} as Record<keyof typeof RANGES, number>
  for (const key of keys) {
    const number = record[key]
    const [minimum, maximum] = RANGES[key]
    if (!Number.isSafeInteger(number) || (number as number) < minimum || (number as number) > maximum) {
      throw new Error(`Plugin configuration ${key} is outside ${String(minimum)}..${String(maximum)}`)
    }
    output[key] = number as number
  }
  if (output.staleCacheMs < output.freshCacheMs) {
    throw new Error('Plugin staleCacheMs must be greater than or equal to freshCacheMs')
  }
  return immutableJsonClone(output) as CapabilityResolverConfiguration
}

/** Whether this exact candidate/version has a typed safe configuration adapter. */
export function hasPluginConfigurationAdapter(candidateRef: string, version: string): boolean {
  return capabilityResolverCandidate(candidateRef, version) !== null
}
