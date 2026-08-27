import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ManagedPluginCli } from '../../src/internal/plugin/index.ts'
import { materializeNpmArchive } from '../../src/providers/npm-archive.ts'

/** Official-CLI test double: it alone owns simulated Profile package-manager writes. */
export class ProfilePluginCli implements ManagedPluginCli {
  readonly calls: Array<Readonly<{
    kind: 'add' | 'remove'
    profileId: string
    packageName: string
    version?: string
    artifactPath?: string
  }>> = []

  constructor(private readonly hostHome: string) {}

  async audit(
    _profileId: string,
    _metadataCache: Parameters<ManagedPluginCli['audit']>[1],
    _requireCurrentProfile: boolean,
  ): Promise<void> {}

  async add(profileId: string, packageName: string, version: string, artifactPath: string): Promise<void> {
    this.calls.push({ kind: 'add', profileId, packageName, version, artifactPath })
    const profile = join(this.hostHome, 'profiles', profileId)
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.dependencies = {
      ...(manifest.dependencies as Record<string, string> | undefined),
      [packageName]: `file:${artifactPath}`,
    }
    const dsh = (manifest.dsh ?? {}) as Record<string, unknown>
    const profileMetadata = (dsh.profile ?? {}) as Record<string, unknown>
    profileMetadata.bundles = [...new Set([
      ...((profileMetadata.bundles ?? []) as string[]).filter(name => name !== packageName),
      packageName,
    ])]
    dsh.profile = profileMetadata
    manifest.dsh = dsh
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    const packagePath = join(profile, 'node_modules', ...packageName.split('/'))
    await rm(packagePath, { recursive: true, force: true })
    await mkdir(dirname(packagePath), { recursive: true })
    const inspection = await materializeNpmArchive(artifactPath, packagePath, null)
    if (inspection.name !== packageName || inspection.version !== version) throw new Error('fake official CLI package mismatch')
  }

  async remove(profileId: string, packageName: string): Promise<void> {
    this.calls.push({ kind: 'remove', profileId, packageName })
    const profile = join(this.hostHome, 'profiles', profileId)
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as Record<string, unknown>
    const dependencies = { ...(manifest.dependencies as Record<string, string> | undefined) }
    delete dependencies[packageName]
    manifest.dependencies = dependencies
    const dsh = (manifest.dsh ?? {}) as Record<string, unknown>
    const profileMetadata = (dsh.profile ?? {}) as Record<string, unknown>
    profileMetadata.bundles = ((profileMetadata.bundles ?? []) as string[]).filter(name => name !== packageName)
    dsh.profile = profileMetadata
    manifest.dsh = dsh
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    await rm(join(profile, 'node_modules', ...packageName.split('/')), { recursive: true, force: true })
  }
}
