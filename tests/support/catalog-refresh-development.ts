import { createHash, createPrivateKey, sign } from 'node:crypto'
import type { CatalogEnvelope, CatalogRoot } from '../../src/catalog-contract.ts'
import type { SignedCatalogDocument } from '../../src/catalog-refresh.ts'

/** Test-only key id. A receipt or public catalog must never trust this key. */
export const DEVELOPMENT_CATALOG_KEY_ID = 'development-only-catalog-refresh-test'

const DEVELOPMENT_PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6yVe+4wyLgMdkkh76mH0yTgPE2lb7YjHN1nS1UFeuRY=\n-----END PUBLIC KEY-----\n'
const DEVELOPMENT_PRIVATE_KEY_PEM = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIOZOOopb+q4GvfmtaeLejFmoLfjnfDcifHbzmrrm0Bss\n-----END PRIVATE KEY-----\n'

/** Public half of the isolated test authority used by module fixtures. */
export const DEVELOPMENT_CATALOG_KEY: CatalogRoot['keys'][number] = Object.freeze({
  keyId: DEVELOPMENT_CATALOG_KEY_ID,
  algorithm: 'ed25519',
  publicKeyPem: DEVELOPMENT_PUBLIC_KEY_PEM,
})

/** Create one cryptographically valid adjacent document for refresh mechanics only. */
export function developmentCatalogSuccessor(current: CatalogEnvelope): SignedCatalogDocument {
  const envelope: CatalogEnvelope = Object.freeze({
    ...current,
    revision: current.revision + 1,
    issuedAt: new Date(Date.parse(current.issuedAt) + 1_000).toISOString(),
    expiresAt: new Date(Date.parse(current.expiresAt) + 1_000).toISOString(),
    previousRevisionDigest: canonicalSha256(current),
  })
  return Object.freeze({
    envelope,
    signatures: Object.freeze([Object.freeze({
      keyId: DEVELOPMENT_CATALOG_KEY_ID,
      algorithm: 'ed25519' as const,
      value: sign(
        null,
        Buffer.from(canonicalJson(envelope)),
        createPrivateKey(DEVELOPMENT_PRIVATE_KEY_PEM),
      ).toString('base64'),
    })]),
  })
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`
  }
  throw new TypeError('development catalog fixture accepts JSON data only')
}

function canonicalSha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}
