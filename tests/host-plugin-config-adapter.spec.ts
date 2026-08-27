import { describe, expect, it } from 'vitest'
import * as adapter from '../src/providers/plugin-config-adapter.ts'
import { CAPABILITY_RESOLVER_CANDIDATES } from '../src/resolver-candidates.ts'

const [resolver010, resolver011] = CAPABILITY_RESOLVER_CANDIDATES

const configuration = {
  freshCacheMs: 5_000,
  staleCacheMs: 30_000,
  fetchTimeoutMs: 10_000,
  maxCatalogBytes: 1_048_576,
  maxCatalogEntries: 2_000,
  maxTaskChars: 4_000,
  maxResults: 5,
  maxCurrentMatches: 10,
  maxDescriptionChars: 500,
  maxMatchedTerms: 10,
}

describe('typed capability-resolver runtime configuration', () => {
  it('binds exact candidate schemas without exposing a Profile patch writer', () => {
    expect(adapter.hasPluginConfigurationAdapter(resolver010.candidateRef, '0.1.0')).toBe(true)
    expect(adapter.hasPluginConfigurationAdapter(resolver011.candidateRef, resolver011.version)).toBe(true)
    expect(adapter.hasPluginConfigurationAdapter(resolver010.candidateRef, '0.1.1')).toBe(false)
    expect(adapter.hasPluginConfigurationAdapter('plugin:dsh-capability-resolver@0.1.2', '0.1.2')).toBe(false)
    expect('buildCapabilityResolverPatch' in adapter).toBe(false)
    expect('PluginConfigurationPatch' in adapter).toBe(false)

    const review010 = adapter.pluginConfigurationReview(resolver010.candidateRef, resolver010.version)
    const review011 = adapter.pluginConfigurationReview(resolver011.candidateRef, resolver011.version)
    expect(review011.schema).toEqual(review010.schema)
    expect(review011.adapterVersion).toBe('dsh-capability-resolver/config@0.1.1')
    expect(review011.adapterDigest).not.toBe(review010.adapterDigest)
    expect(adapter.validateCapabilityResolverConfiguration(configuration)).toEqual(configuration)
  })

  it('rejects incomplete fields, invalid ranges, and unknown candidate schemas', () => {
    const { maxResults: _removed, ...incomplete } = configuration
    expect(() => adapter.validateCapabilityResolverConfiguration(incomplete)).toThrow('exactly')
    expect(() => adapter.validateCapabilityResolverConfiguration({ ...configuration, fetchTimeoutMs: 99 })).toThrow('outside')
    expect(() => adapter.validateCapabilityResolverConfiguration({
      ...configuration,
      freshCacheMs: 40_000,
      staleCacheMs: 30_000,
    })).toThrow('greater than or equal')
    expect(() => adapter.pluginConfigurationReview(resolver010.candidateRef, resolver011.version))
      .toThrow('no exact typed configuration adapter')
  })
})
