import { canonicalSha256, verifyBootstrapCatalog, type VerifiedCatalog } from '../../src/catalog.ts'
import { BOOTSTRAP_CATALOG_ENVELOPE } from '../../src/catalog-data.ts'
import { SUPPORTED_DSH_VERSION } from '../../src/policy/evaluate.ts'

/**
 * Project the signed stable bootstrap entries onto the alpha Host for policy-focused tests.
 *
 * The production bootstrap remains immutable and therefore fails closed on alpha. Tests that
 * exercise a later lifecycle decision need an admitted input without weakening that behavior.
 */
export function alphaPolicyCatalogFixture(): VerifiedCatalog {
  const verified = verifyBootstrapCatalog(Date.parse(BOOTSTRAP_CATALOG_ENVELOPE.issuedAt) + 1_000)
  const entries = verified.envelope.entries.map(entry => ({
    ...entry,
    compatibility: { ...entry.compatibility, dsh: SUPPORTED_DSH_VERSION },
  }))
  return {
    keyIds: verified.keyIds,
    envelope: {
      ...verified.envelope,
      entries,
      entriesDigest: canonicalSha256(entries),
    },
  }
}
