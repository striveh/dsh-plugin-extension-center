import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type UserConfig } from 'tsdown'

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]
const CLIENT_EXTERNALS: readonly string[] = [
  ...PLATFORM_MODULES,
]
const PLUGIN_ID: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name
const CSS_VIRTUAL_PREFIX = '\0dsh-extension-center-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const PROJECT_ROOT = resolvePath('.')

/** Resolve emitted CSS imports back to their source assets. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const buildRoot = resolvePath('lib/.build')
  const relativeAsset = relative(buildRoot, emitted)
  if (!relativeAsset.startsWith('..')) {
    const sourceAsset = resolvePath('src', relativeAsset)
    if (existsSync(sourceAsset)) return sourceAsset
  }
  return emitted
}

/** Return one canonical project-relative asset path. */
function projectRelativeAssetPath(filename: string): string {
  const projectRelative = relative(PROJECT_ROOT, filename).replaceAll('\\', '/')
  if (projectRelative === '' || projectRelative === '..' || projectRelative.startsWith('../')) {
    throw new Error(`client CSS asset is outside the project root: ${filename}`)
  }
  return projectRelative
}

const config: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'lib/.build/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => CLIENT_EXTERNALS.includes(id) ? undefined : true,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-extension-center-client-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: unsupported value import "${source}"; use a platform module, a type-only import, or a Cordis service`,
      )
    },
  }, {
    name: 'dsh-extension-center-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined ? source : sourceAssetPath(source, importer)
      return CSS_VIRTUAL_PREFIX + projectRelativeAssetPath(absolute) + CSS_VIRTUAL_SUFFIX
    },
    load(id: string) {
      if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const projectRelative = id.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const filename = resolvePath(PROJECT_ROOT, projectRelative)
      if (projectRelativeAssetPath(filename) !== projectRelative) {
        throw new Error(`client CSS virtual asset is not canonical: ${projectRelative}`)
      }
      this.addWatchFile(filename)
      const result = transform({
        filename,
        projectRoot: PROJECT_ROOT,
        code: readFileSync(filename),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classes: Record<string, string> = {}
      for (const [local, value] of Object.entries(result.exports ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        classes[local] = value.name
      }
      const tagId = `${PLUGIN_ID}/${basename(filename)}`
      return [
        `export const cssText = ${JSON.stringify(result.code.toString())};`,
        `export const styleTagId = ${JSON.stringify(tagId)};`,
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig(config)
