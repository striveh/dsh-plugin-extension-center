#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const CENTER_PACKAGE = 'dsh-plugin-extension-center'
const ALPHA_DSH_VERSION = '0.1.2-alpha.1'
const ALPHA_CENTER_VERSION = /^0\.2\.0-alpha\.[1-9][0-9]*$/u
const DSH_CLIENT_PACKAGES = Object.freeze([
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-slots',
])
const VERSIONED_DEPENDENCY_GROUPS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
])
const LOCKED_DEPENDENCY_GROUPS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
])

/** Reject an alpha manifest that would install mixed DSH release lines. */
export function assertAlphaPublicationManifest(manifest) {
  if (manifest?.name !== CENTER_PACKAGE || !ALPHA_CENTER_VERSION.test(manifest?.version ?? '')) {
    throw new Error('alpha-publish: Center package identity is not an exact alpha release')
  }
  if (manifest.private !== undefined || manifest.publishConfig?.access !== 'public'
    || manifest.publishConfig?.tag !== 'next') {
    throw new Error('alpha-publish: package must publish publicly under the next tag')
  }
  if (manifest.engines?.dsh !== ALPHA_DSH_VERSION) {
    throw new Error('alpha-publish: engines.dsh does not match the exact official alpha')
  }
  if (manifest.dependencies?.['@deepseek-ai/dsh-mcp-client'] !== ALPHA_DSH_VERSION) {
    throw new Error('alpha-publish: runtime MCP Client is not aligned to the exact official alpha')
  }
  for (const packageName of DSH_CLIENT_PACKAGES) {
    if (manifest.peerDependencies?.[packageName] !== ALPHA_DSH_VERSION
      || manifest.devDependencies?.[packageName] !== ALPHA_DSH_VERSION) {
      throw new Error(`alpha-publish: ${packageName} is not aligned to the exact official alpha`)
    }
  }
  if (manifest.devDependencies?.['@deepseek-ai/dsh'] !== ALPHA_DSH_VERSION
  ) {
    throw new Error('alpha-publish: DSH development evidence is not aligned to the exact official alpha')
  }
  for (const { group, packageName, version } of manifestDshDependencies(manifest)) {
    if (version !== ALPHA_DSH_VERSION) {
      throw new Error(`alpha-publish: ${group}.${packageName} does not use the exact official alpha`)
    }
  }
  for (const group of ['bundledDependencies', 'bundleDependencies']) {
    const bundled = manifest[group]
    if (bundled !== undefined && (!Array.isArray(bundled)
      || bundled.some(packageName => typeof packageName !== 'string'))) {
      throw new Error(`alpha-publish: ${group} must be an array of package names`)
    }
    if (bundled?.some(isDshPackageName)) {
      throw new Error(`alpha-publish: ${group} cannot hide a DSH release without an exact version`)
    }
  }
  if (VERSIONED_DEPENDENCY_GROUPS.some(group => manifest[group]?.['@deepseek-ai/dsh-client-runtime'] !== undefined)) {
    throw new Error('alpha-publish: removed dsh-client-runtime must not re-enter the package')
  }
  return Object.freeze({ centerVersion: manifest.version, dshVersion: ALPHA_DSH_VERSION })
}

/** Reject a lockfile that does not resolve every direct DSH alpha input exactly. */
export function assertAlphaPublicationLock(lockText, manifest) {
  const identity = assertAlphaPublicationManifest(manifest)
  let lock
  try {
    lock = parseYaml(lockText, { maxAliasCount: 0, uniqueKeys: true })
  } catch (cause) {
    throw new Error('alpha-publish: pnpm lockfile is not unambiguous YAML', { cause })
  }
  if (lock?.lockfileVersion !== '9.0') {
    throw new Error('alpha-publish: pnpm lockfile version is not the audited pnpm 11 format')
  }
  const importer = lock?.importers?.['.']
  if (importer === null || typeof importer !== 'object' || Array.isArray(importer)) {
    throw new Error('alpha-publish: root lockfile importer is missing')
  }
  const packages = lockSection(lock, 'packages')
  const snapshots = lockSection(lock, 'snapshots')
  const lockedManifestEntries = manifestDshDependencies(manifest)
    .filter(({ group }) => LOCKED_DEPENDENCY_GROUPS.includes(group))
  const locations = new Map()
  for (const entry of lockedManifestEntries) {
    const previous = locations.get(entry.packageName)
    if (previous !== undefined && previous !== entry.group) {
      throw new Error(`alpha-publish: ${entry.packageName} appears in multiple install dependency groups`)
    }
    locations.set(entry.packageName, entry.group)
  }
  for (const [packageName, group] of locations) {
    const resolution = importer[group]?.[packageName]
    if (resolution?.specifier !== identity.dshVersion
      || typeof resolution.version !== 'string'
      || !isExactPnpmResolution(resolution.version, identity.dshVersion)) {
      throw new Error(`alpha-publish: lockfile does not bind ${packageName}@${identity.dshVersion}`)
    }
  }
  const requiredNodes = new Set(manifestDshDependencies(manifest).map(({ packageName }) => packageName))
  for (const [sectionName, section] of [['packages', packages], ['snapshots', snapshots]]) {
    for (const [key, value] of Object.entries(section)) {
      const parsedKey = parseDshLockKey(key)
      if (parsedKey !== null) {
        if (!isExactPnpmResolution(parsedKey.resolution, identity.dshVersion)) {
          throw new Error(`alpha-publish: lockfile contains mixed DSH release ${key}`)
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`alpha-publish: ${sectionName} contains an invalid DSH node ${key}`)
        }
      }
      assertLockDependencyReferences(value, sectionName, key, identity.dshVersion)
    }
    for (const packageName of requiredNodes) {
      const found = Object.keys(section).some(key => {
        const parsed = parseDshLockKey(key)
        return parsed?.packageName === packageName
          && isExactPnpmResolution(parsed.resolution, identity.dshVersion)
      })
      if (!found) {
        throw new Error(`alpha-publish: ${sectionName} omits the direct DSH node ${packageName}@${identity.dshVersion}`)
      }
    }
  }
  return identity
}

function isExactPnpmResolution(value, version) {
  return value === version || value.startsWith(`${version}(`) && value.endsWith(')')
}

function isDshPackageName(packageName) {
  return packageName === '@deepseek-ai/dsh' || packageName.startsWith('@deepseek-ai/dsh-')
}

function manifestDshDependencies(manifest) {
  const entries = []
  for (const group of VERSIONED_DEPENDENCY_GROUPS) {
    const dependencies = manifest[group]
    if (dependencies === undefined) continue
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new Error(`alpha-publish: ${group} must be an object`)
    }
    for (const [packageName, version] of Object.entries(dependencies)) {
      if (isDshPackageName(packageName)) entries.push({ group, packageName, version })
    }
  }
  return entries
}

function lockSection(lock, sectionName) {
  const section = lock?.[sectionName]
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    throw new Error(`alpha-publish: lockfile ${sectionName} section is missing or invalid`)
  }
  return section
}

function parseDshLockKey(key) {
  const match = /^(@deepseek-ai\/dsh(?:-[^@]+)?)@(.+)$/u.exec(key)
  return match === null ? null : { packageName: match[1], resolution: match[2] }
}

function assertLockDependencyReferences(value, sectionName, key, version) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  // Package peerDependencies are semver constraints, not resolved lock nodes.
  for (const group of ['dependencies', 'optionalDependencies']) {
    const dependencies = value[group]
    if (dependencies === undefined) continue
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new Error(`alpha-publish: ${sectionName}.${key}.${group} is invalid`)
    }
    for (const [packageName, resolution] of Object.entries(dependencies)) {
      if (isDshPackageName(packageName)
        && (typeof resolution !== 'string' || !isExactPnpmResolution(resolution, version))) {
        throw new Error(`alpha-publish: ${sectionName}.${key} references mixed DSH release ${packageName}@${String(resolution)}`)
      }
    }
  }
}

async function main() {
  const [manifestText, lockText] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'),
  ])
  const identity = assertAlphaPublicationLock(lockText, JSON.parse(manifestText))
  process.stdout.write(`alpha-publish: ${CENTER_PACKAGE}@${identity.centerVersion} is dependency-aligned to official DSH ${identity.dshVersion}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
