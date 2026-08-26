import { describe, expect, it } from 'vitest'
import {
  buildCapabilityResolverPatch,
  hasPluginConfigurationAdapter,
} from '../src/providers/plugin-config-adapter.ts'

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

describe('typed capability-resolver Profile configuration', () => {
  it('creates and replaces only the owner-marked exact override with whole-file digests', () => {
    const current = '- id: existing-plugin\n  config:\n    enabled: true\n'
    const created = buildCapabilityResolverPatch(current, configuration)

    expect(hasPluginConfigurationAdapter(created.candidateRef, '0.1.0')).toBe(true)
    expect(hasPluginConfigurationAdapter(created.candidateRef, '0.1.1')).toBe(false)
    expect(created.expectedDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(created.nextDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(created.nextUtf8).toContain('dsh-extension-center-owned: dsh-capability-resolver')
    expect(created.nextUtf8).toContain('freshCacheMs: 5000')
    expect(created.nextUtf8).toContain('id: existing-plugin')

    const replaced = buildCapabilityResolverPatch(created.nextUtf8, { ...configuration, freshCacheMs: 6_000 })
    expect(replaced.expectedDigest).toBe(created.nextDigest)
    expect(replaced.nextUtf8.match(/id: dsh-capability-resolver/g)).toHaveLength(1)
    expect(replaced.nextUtf8).toContain('freshCacheMs: 6000')
  })

  it('rejects unowned overrides, duplicate rows, aliases, incomplete fields, and invalid ranges', () => {
    expect(() => buildCapabilityResolverPatch('- id: dsh-capability-resolver\n  config: {}\n', configuration))
      .toThrow('not owned')
    expect(() => buildCapabilityResolverPatch([
      '# dsh-extension-center-owned: dsh-capability-resolver',
      '- id: dsh-capability-resolver',
      '  config: {}',
      '# dsh-extension-center-owned: dsh-capability-resolver',
      '- id: dsh-capability-resolver',
      '  config: {}',
      '',
    ].join('\n'), configuration)).toThrow('duplicate')
    expect(() => buildCapabilityResolverPatch('- &row\n  id: existing\n- *row\n', configuration)).toThrow('aliases')
    const { maxResults: _removed, ...incomplete } = configuration
    expect(() => buildCapabilityResolverPatch('[]\n', incomplete)).toThrow('exactly')
    expect(() => buildCapabilityResolverPatch('[]\n', { ...configuration, fetchTimeoutMs: 99 })).toThrow('outside')
    expect(() => buildCapabilityResolverPatch('[]\n', {
      ...configuration,
      freshCacheMs: 40_000,
      staleCacheMs: 30_000,
    })).toThrow('greater than or equal')
  })
})
