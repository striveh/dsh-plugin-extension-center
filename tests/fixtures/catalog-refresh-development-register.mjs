import { registerHooks } from 'node:module'

const productionUrl = new URL('../../src/catalog-data.ts', import.meta.url).href
const fixtureUrl = new URL('./catalog-refresh-development-data.mts', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    return resolved.url === productionUrl
      ? { url: fixtureUrl, shortCircuit: true }
      : resolved
  },
})
