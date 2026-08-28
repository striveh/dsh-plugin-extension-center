import {
  BOOTSTRAP_CATALOG_ROOT as PRODUCTION_CATALOG_ROOT,
} from '../../src/catalog-data.ts?catalog-refresh-production'
import { DEVELOPMENT_CATALOG_KEY } from '../support/catalog-refresh-development.ts'

export {
  BOOTSTRAP_CATALOG_ENTRIES,
  BOOTSTRAP_CATALOG_ENVELOPE,
  BOOTSTRAP_CATALOG_SIGNATURES,
} from '../../src/catalog-data.ts?catalog-refresh-production'

/** Isolated worker-only authority. The production module remains unchanged. */
export const BOOTSTRAP_CATALOG_ROOT = Object.freeze({
  ...PRODUCTION_CATALOG_ROOT,
  keys: Object.freeze([...PRODUCTION_CATALOG_ROOT.keys, DEVELOPMENT_CATALOG_KEY]),
})
