import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import { canonicalSha256, immutableJsonClone } from '../domain/index.ts'
import type { ManagedTargetRecord, ManagedVersion, SkillsOwner } from '../host/index.ts'
import { CenterStateStore, openRegularNoFollow, safeChild, storageKey } from '../host/index.ts'
import type { RpcJson } from '../service/rpc-contract.ts'
import { managedStateDigest, nextManagedRecord } from './records.ts'
import type {
  AppliedProviderOperation,
  LifecycleProvider,
  PreparedProviderOperation,
  ProviderOperationRequest,
  ProviderVerification,
} from './types.ts'

interface SkillConfiguration {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly projectRoot: string | null
}

interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly content: string
}

interface PreparedSkill {
  readonly parsed: ParsedSkill | null
  readonly configuration: SkillConfiguration
  readonly destination: string | null
}

interface SkillRecoveryPoint {
  readonly parsed: Readonly<{ name: string; description: string }> | null
  readonly configuration: SkillConfiguration
  readonly destination: string | null
  readonly stagingPath: string | null
  readonly contentIntegrity: string
}

function bytesDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

/** Exact regular-file bytes and digest observed without following the final path. */
export interface SkillArtifactInspection {
  readonly text: string
  readonly integrity: string
  readonly matchesExpected: boolean
  readonly executable: boolean
}

/** Hash one bounded regular Skill artifact using its declared integrity algorithm. */
export async function inspectSkillArtifact(path: string, expectedIntegrity: string): Promise<SkillArtifactInspection> {
  const separator = expectedIntegrity.indexOf(':')
  const algorithm = expectedIntegrity.slice(0, separator)
  const encoded = expectedIntegrity.slice(separator + 1)
  if (!['sha256', 'sha512'].includes(algorithm)
    || !(/^[0-9a-f]+$/.test(encoded) || algorithm === 'sha512' && /^[A-Za-z0-9+/]{86}==$/.test(encoded))) {
    throw new Error('Skill artifact integrity is invalid')
  }
  const handle = await openRegularNoFollow(path)
  try {
    const info = await handle.stat()
    if (info.size > 1024 * 1024) throw new Error('SKILL.md exceeds the P0 size bound')
    const bytes = await handle.readFile()
    const digest = createHash(algorithm).update(bytes).digest(/^[0-9a-f]+$/.test(encoded) ? 'hex' : 'base64')
    const integrity = `${algorithm}:${digest}`
    return Object.freeze({
      text: bytes.toString('utf8'),
      integrity,
      matchesExpected: integrity === expectedIntegrity,
      executable: process.platform !== 'win32' && (info.mode & 0o111) !== 0,
    })
  } finally {
    await handle.close()
  }
}

function object(value: RpcJson): Readonly<Record<string, RpcJson>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('skill configuration must be an object')
  return value as Readonly<Record<string, RpcJson>>
}

function configuration(value: RpcJson): SkillConfiguration {
  const record = object(value)
  const keys = Object.keys(record).sort()
  if (keys.some(key => !['modelInvocable', 'projectRoot', 'userInvocable'].includes(key))) {
    throw new Error('skill configuration contains an unsupported field')
  }
  const modelInvocable = record.modelInvocable ?? true
  const userInvocable = record.userInvocable ?? true
  const projectRootValue = record.projectRoot ?? null
  if (typeof modelInvocable !== 'boolean' || typeof userInvocable !== 'boolean') {
    throw new Error('skill invocation flags must be boolean')
  }
  if (projectRootValue !== null && (typeof projectRootValue !== 'string' || projectRootValue.length === 0 || !isAbsolute(projectRootValue))) {
    throw new Error('skill projectRoot must be an absolute path or null')
  }
  const projectRoot = projectRootValue === null ? null : resolve(projectRootValue)
  return Object.freeze({ modelInvocable, userInvocable, projectRoot })
}

/** Resolve and validate the exact Skill scope before an immutable plan is minted. */
export async function preflightSkillConfiguration(value: RpcJson, scopeKey: string): Promise<RpcJson> {
  const config = configuration(value)
  if (scopeKey === 'project' && config.projectRoot === null) {
    throw new Error('project Skill install requires an exact projectRoot')
  }
  if (scopeKey === 'user' && config.projectRoot !== null) {
    throw new Error('user Skill install must not carry a projectRoot')
  }
  if (!['project', 'user'].includes(scopeKey)) throw new Error('Skill scope is not admitted')
  if (config.projectRoot !== null && await realpath(config.projectRoot) !== config.projectRoot) {
    throw new Error('Skill projectRoot must be its canonical real path')
  }
  return immutableJsonClone(config) as unknown as RpcJson
}

function parseSkill(text: string): ParsedSkill {
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('SKILL.md exceeds the P0 size bound')
  if (!text.startsWith('---\n')) throw new Error('SKILL.md requires YAML frontmatter')
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error('SKILL.md frontmatter is incomplete')
  const frontmatter = text.slice(4, end)
  if (Buffer.byteLength(frontmatter, 'utf8') > 32 * 1024) throw new Error('SKILL.md frontmatter exceeds the P0 bound')
  const document = parseDocument(frontmatter, { schema: 'core', strict: true, uniqueKeys: true })
  if (document.errors.length > 0 || document.warnings.length > 0) throw new Error('SKILL.md frontmatter is not strict YAML')
  let fields: unknown
  try {
    fields = document.toJS({ maxAliasCount: 0 })
  } catch (cause) {
    throw new Error('SKILL.md frontmatter aliases are forbidden', { cause })
  }
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw new Error('SKILL.md frontmatter must be a mapping')
  const mapping = fields as Record<string, unknown>
  const name = mapping.name
  const description = mapping.description
  if (typeof name !== 'string' || typeof description !== 'string') throw new Error('SKILL.md name and description must be strings')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || description.length === 0) {
    throw new Error('SKILL.md requires a kebab-case name and description')
  }
  return Object.freeze({ name, description, content: text.slice(end + '\n---\n'.length) })
}

function recoveryPoint(value: RpcJson): SkillRecoveryPoint {
  const input = object(value)
  if (input.kind !== 'skill'
    || (input.destination !== null && typeof input.destination !== 'string')
    || (input.stagingPath !== null && typeof input.stagingPath !== 'string')
    || typeof input.contentIntegrity !== 'string') {
    throw new Error('Skill recovery point is invalid')
  }
  let parsed: SkillRecoveryPoint['parsed'] = null
  if (input.parsed !== null) {
    const fields = object(input.parsed as RpcJson)
    if (typeof fields.name !== 'string' || typeof fields.description !== 'string') {
      throw new Error('Skill recovery metadata is invalid')
    }
    parsed = Object.freeze({ name: fields.name, description: fields.description })
  }
  return Object.freeze({
    parsed,
    configuration: configuration(input.configuration as RpcJson),
    destination: input.destination as string | null,
    stagingPath: input.stagingPath as string | null,
    contentIntegrity: input.contentIntegrity,
  })
}

function state(value: ManagedVersion): Readonly<{
  skillName: string
  description: string
  modelInvocable: boolean
  userInvocable: boolean
}> {
  const raw = value.kindState
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('managed Skill state is invalid')
  const record = raw as Record<string, RpcJson>
  if (
    typeof record.skillName !== 'string'
    || typeof record.description !== 'string'
    || typeof record.modelInvocable !== 'boolean'
    || typeof record.userInvocable !== 'boolean'
  ) throw new Error('managed Skill state fields are invalid')
  return {
    skillName: record.skillName,
    description: record.description,
    modelInvocable: record.modelInvocable,
    userInvocable: record.userInvocable,
  }
}

async function lookupCwd(options: unknown): Promise<string | null> {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return null
  const cwd = (options as { cwd?: unknown }).cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null
  try {
    return await realpath(cwd)
  } catch {
    return null
  }
}

async function visibleInLookup(record: ManagedTargetRecord, options: unknown): Promise<boolean> {
  const current = record.current
  if (current === null) return false
  const config = configuration(current.configuration)
  if (record.scopeKey === 'user') return config.projectRoot === null
  if (record.scopeKey !== 'project' || config.projectRoot === null) return false
  const cwd = await lookupCwd(options)
  if (cwd === null) return false
  const rel = relative(config.projectRoot, cwd)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))
}

function isMaterialDirectory(value: unknown, materialPath: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Readonly<Record<string, unknown>>
  return record.kind === 'directory' && record.path === dirname(materialPath)
}

/** Center-owned Skill lifecycle and merged-registry provider. */
export class SkillLifecycleProvider implements LifecycleProvider {
  readonly kind = 'skill' as const
  private invalidate = (): void => {}

  constructor(
    private readonly root: string,
    private readonly store: CenterStateStore,
    private readonly skills: SkillsOwner,
  ) {}

  /** Register the center's durable records as one real merged Skill provider. */
  register(): () => void {
    return this.skills.registerProvider((control) => {
      this.invalidate = control.invalidate
      return {
        name: 'extension-center',
        list: async (options: unknown) => {
          const values = await this.store.listManaged()
          const output = []
          for (const record of values) {
            const current = record.kind === 'skill' ? record.current : null
            if (current === null || !current.enabled || !await visibleInLookup(record, options)) continue
            try {
              await this.inspectManaged(current)
            } catch {
              continue
            }
            const metadata = state(current)
            output.push({
              name: metadata.skillName,
              description: metadata.description,
              invocation: { modelInvocable: metadata.modelInvocable, userInvocable: metadata.userInvocable },
              source: 'extension-center',
              provider: 'extension-center',
              resourceBase: { kind: 'directory', path: dirname(current.materialPath) },
              rank: 50,
              locator: record.targetKey,
              path: current.materialPath,
            })
          }
          return output
        },
        get: async (candidate: unknown, options: unknown) => {
          if (typeof candidate !== 'object' || candidate === null) return undefined
          const locator = (candidate as { locator?: unknown }).locator
          if (typeof locator !== 'string') return undefined
          const record = await this.store.getManaged(locator)
          const current = record?.kind === 'skill' ? record.current : null
          if (current === null || current === undefined || !current.enabled || record === undefined || !await visibleInLookup(record, options)) return undefined
          const metadata = state(current)
          const inspected = await this.inspectManaged(current)
          const parsed = parseSkill(inspected.text)
          return {
            name: metadata.skillName,
            description: metadata.description,
            invocation: { modelInvocable: metadata.modelInvocable, userInvocable: metadata.userInvocable },
            source: 'extension-center',
            provider: 'extension-center',
            resourceBase: { kind: 'directory', path: dirname(current.materialPath) },
            path: current.materialPath,
            content: parsed.content,
          }
        },
      }
    })
  }

  async observe(targetKey: string): Promise<ManagedTargetRecord | null> {
    return await this.store.getManaged(targetKey) ?? null
  }

  async prepare(request: ProviderOperationRequest): Promise<PreparedProviderOperation> {
    const before = await this.observe(request.plan.targetKey)
    const config = configuration(await preflightSkillConfiguration(request.payload.configuration, request.plan.scopeKey))
    const priorMaterial = request.plan.operationKind === 'restore'
      ? before?.removed ?? before?.lastGood ?? null
      : request.plan.operationKind === 'install' || request.plan.operationKind === 'purge'
        ? null
        : before?.current ?? null
    const priorInspection = priorMaterial === null ? null : await this.inspectManaged(priorMaterial)
    const review = request.plan.reviewEvidence
    if (review.kind !== 'skill') throw new Error('Skill plan has no Skill review evidence')
    if (priorInspection?.text !== (review.body.before ?? undefined)
      || priorInspection !== null && bytesDigest(priorInspection.text) !== review.body.beforeDigest
      || review.files.length !== 1
      || review.files[0]!.linkBefore !== null
      || review.files[0]!.linkAfter !== null
      || review.files[0]!.executableBefore !== (priorInspection?.executable ?? false)) {
      throw new Error('managed Skill does not match the immutable review evidence')
    }
    let parsed: ParsedSkill | null = null
    let destination: string | null = null
    let stagingPath: string | null = null
    if (request.plan.operationKind === 'install' || request.plan.operationKind === 'update') {
      if (request.artifactPath === null) throw new Error('Skill install or update requires an acquired artifact')
      const inspected = await inspectSkillArtifact(request.artifactPath, request.plan.artifactIntegrity)
      if (!inspected.matchesExpected) throw new Error('Skill artifact bytes do not match the immutable plan integrity')
      const text = inspected.text
      if (text !== review.body.after
        || bytesDigest(text) !== review.body.afterDigest
        || inspected.executable !== review.files[0]!.executableAfter) {
        throw new Error('Skill artifact does not match the immutable review evidence')
      }
      parsed = parseSkill(text)
      if (parsed.name !== request.plan.extensionId) throw new Error('SKILL.md name does not match the immutable plan')
      const options = config.projectRoot === null ? {} : { cwd: config.projectRoot }
      const visible = await this.skills.snapshot(options)
      if (!visible.complete) throw new Error('Skill registry snapshot is incomplete')
      const winner = visible.skills.find((item) => {
        if (typeof item !== 'object' || item === null) return false
        return (item as { name?: unknown }).name === parsed?.name
      })
      if (winner !== undefined) {
        const observed = winner as { provider?: unknown; resourceBase?: unknown }
        const prior = before?.current
        if (observed.provider !== 'extension-center'
          || prior === null
          || prior === undefined
          || state(prior).skillName !== parsed.name
          || !isMaterialDirectory(observed.resourceBase, prior.materialPath)) {
          throw new Error('another Skill provider already wins this name')
        }
        const definition = await this.skills.get(parsed.name, options) as { provider?: unknown; path?: unknown } | undefined
        if (definition?.provider !== 'extension-center' || definition.path !== prior.materialPath) {
          throw new Error('current Skill winner changed before staging')
        }
      } else if (before?.current !== null && before?.current !== undefined) {
        throw new Error('current center Skill is not the merged-registry winner')
      }
      const materialRoot = safeChild(this.root, 'material', 'skills', storageKey(request.plan.targetKey))
      destination = safeChild(materialRoot, storageKey(request.plan.artifactIntegrity))
      stagingPath = `${destination}.stage-${storageKey(request.authorization.operationId)}`
      await mkdir(materialRoot, { recursive: true, mode: 0o700 })
      await mkdir(stagingPath, { recursive: false, mode: 0o700 })
      const output = await open(join(stagingPath, 'SKILL.md'), 'wx', 0o600)
      try {
        await output.writeFile(text, 'utf8')
        await output.sync()
      } finally {
        await output.close()
      }
    }
    return Object.freeze({
      request,
      before,
      beforeDigest: managedStateDigest(before),
      stagingPath,
      prepared: Object.freeze({ parsed, configuration: config, destination } satisfies PreparedSkill),
    })
  }

  recoveryPoint(prepared: PreparedProviderOperation): RpcJson {
    const detail = prepared.prepared as PreparedSkill
    return immutableJsonClone({
      kind: 'skill',
      parsed: detail.parsed === null ? null : { name: detail.parsed.name, description: detail.parsed.description },
      configuration: detail.configuration,
      destination: detail.destination,
      stagingPath: prepared.stagingPath,
      contentIntegrity: prepared.request.plan.artifactIntegrity,
    }) as unknown as RpcJson
  }

  async apply(prepared: PreparedProviderOperation): Promise<AppliedProviderOperation> {
    const detail = prepared.prepared as PreparedSkill
    const { request } = prepared
    let supplied: ManagedVersion | null = null
    if (detail.parsed !== null && detail.destination !== null && prepared.stagingPath !== null) {
      await mkdir(dirname(detail.destination), { recursive: true, mode: 0o700 })
      await rename(prepared.stagingPath, detail.destination)
      supplied = immutableJsonClone({
        candidateRef: request.plan.candidateRef,
        artifactRevision: request.plan.artifactRevision,
        artifactIntegrity: request.plan.artifactIntegrity,
        materialPath: join(detail.destination, 'SKILL.md'),
        configuration: request.payload.configuration,
        enabled: request.plan.desiredState === 'enabled',
        ownerRevision: request.plan.fences.ownerRevision,
        kindState: {
          skillName: detail.parsed.name,
          description: detail.parsed.description,
          modelInvocable: detail.configuration.modelInvocable,
          userInvocable: detail.configuration.userInvocable,
        },
      }) as unknown as ManagedVersion
    }
    let after = nextManagedRecord(prepared.before, request, supplied, Date.now())
    if (request.plan.operationKind === 'configure' && after.current !== null) {
      const priorState = state(after.current)
      after = immutableJsonClone({
        ...after,
        current: {
          ...after.current,
          kindState: {
            ...priorState,
            modelInvocable: detail.configuration.modelInvocable,
            userInvocable: detail.configuration.userInvocable,
          },
        },
      }) as ManagedTargetRecord
    }
    await this.store.putManaged(after, prepared.before?.revision ?? 0)
    if (request.plan.operationKind === 'purge') await this.removeRetained(prepared.before)
    this.invalidate()
    return Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ operationId: request.authorization.operationId, after: managedStateDigest(after) }),
      afterDigest: managedStateDigest(after),
      restartRequired: false,
      restartToken: null,
      rollbackRestartRequired: false,
    })
  }

  async verify(applied: AppliedProviderOperation): Promise<ProviderVerification | null> {
    const current = await this.store.getManaged(applied.prepared.request.plan.targetKey)
    const operation = applied.prepared.request.plan.operationKind
    if (operation === 'uninstall' || operation === 'purge') {
      if (current?.current !== null) throw new Error('removed Skill remains active in center inventory')
      const removed = operation === 'uninstall'
        ? applied.prepared.before?.current
        : applied.prepared.before?.removed ?? applied.prepared.before?.lastGood
      if (removed !== null && removed !== undefined) {
        const metadata = state(removed)
        const config = configuration(removed.configuration)
        const options = config.projectRoot === null ? {} : { cwd: config.projectRoot }
        const snapshot = await this.skills.snapshot(options)
        if (!snapshot.complete) throw new Error('Skill registry snapshot is incomplete')
        const winner = snapshot.skills.find((item) => {
          if (typeof item !== 'object' || item === null) return false
          return (item as { name?: unknown }).name === metadata.skillName
        }) as { provider?: unknown } | undefined
        const definition = await this.skills.get(metadata.skillName, options) as { provider?: unknown } | undefined
        if (winner?.provider === 'extension-center' || definition?.provider === 'extension-center') {
          throw new Error('removed Skill still contributes to the merged registry')
        }
        return Object.freeze({
          digest: canonicalSha256({
            current: null,
            skillName: metadata.skillName,
            winnerProvider: typeof winner?.provider === 'string' ? winner.provider : null,
            definitionProvider: typeof definition?.provider === 'string' ? definition.provider : null,
          }),
        })
      }
      return Object.freeze({ digest: canonicalSha256({ current: null, provider: 'extension-center' }) })
    }
    const version = current?.current
    if (version === null || version === undefined) throw new Error('managed Skill has no current material')
    await this.inspectManaged(version)
    const metadata = state(version)
    const config = configuration(version.configuration)
    const options = config.projectRoot === null ? {} : { cwd: config.projectRoot }
    const snapshot = await this.skills.snapshot(options)
    if (!snapshot.complete) throw new Error('Skill registry snapshot is incomplete')
    const winner = snapshot.skills.find((item) => {
      if (typeof item !== 'object' || item === null) return false
      return (item as { name?: unknown }).name === metadata.skillName
    }) as { provider?: unknown; resourceBase?: unknown; invocation?: unknown } | undefined
    const definition = await this.skills.get(metadata.skillName, options) as {
      provider?: unknown
      path?: unknown
      invocation?: { modelInvocable?: unknown; userInvocable?: unknown }
    } | undefined
    if (!version.enabled) {
      if (winner?.provider === 'extension-center' || definition?.provider === 'extension-center') {
        throw new Error('disabled Skill still contributes to the merged registry')
      }
      return Object.freeze({ digest: canonicalSha256({ disabled: true, winner: winner ?? null }) })
    }
    const winnerInvocation = winner?.invocation as { modelInvocable?: unknown; userInvocable?: unknown } | undefined
    if (
      winner?.provider !== 'extension-center'
      || !isMaterialDirectory(winner.resourceBase, version.materialPath)
      || definition?.provider !== 'extension-center'
      || definition.path !== version.materialPath
      || winnerInvocation?.modelInvocable !== metadata.modelInvocable
      || winnerInvocation.userInvocable !== metadata.userInvocable
      || definition.invocation?.modelInvocable !== metadata.modelInvocable
      || definition.invocation.userInvocable !== metadata.userInvocable
    ) throw new Error('managed Skill is not the real merged-registry winner')
    return Object.freeze({ digest: canonicalSha256({ winner, definitionPath: definition.path }) })
  }

  async rollback(applied: AppliedProviderOperation) {
    const current = await this.store.getManaged(applied.prepared.request.plan.targetKey)
    if (current === undefined) throw new Error('managed Skill disappeared before rollback')
    const before = applied.prepared.before
    const createdMaterial = current.current?.materialPath
    const retainedBefore = new Set([
      before?.current?.materialPath,
      before?.lastGood?.materialPath,
      before?.removed?.materialPath,
    ].filter((path): path is string => path !== undefined))
    if (before === null) {
      await this.store.deleteManaged(current.targetKey, current.revision)
    } else {
      await this.store.putManaged(immutableJsonClone({
        ...before,
        revision: current.revision + 1,
        lastOperationId: applied.prepared.request.authorization.operationId,
        updatedAtMs: Date.now(),
      }) as ManagedTargetRecord, current.revision)
    }
    if (createdMaterial !== undefined && !retainedBefore.has(createdMaterial)) {
      await this.removeMaterial(createdMaterial)
    }
    this.invalidate()
    return applied.prepared.beforeDigest
  }

  async recover(request: ProviderOperationRequest): Promise<AppliedProviderOperation | null> {
    const snapshot = await this.store.getProviderSnapshot(request.authorization.operationId)
    if (snapshot === undefined || snapshot.targetKey !== request.plan.targetKey
      || snapshot.beforeDigest !== managedStateDigest(snapshot.before)) throw new Error('Skill recovery snapshot is absent or corrupt')
    let current = await this.store.getManaged(request.plan.targetKey)
    if (current?.lastOperationId !== request.authorization.operationId) {
      if (!['install', 'update'].includes(request.plan.operationKind)) return null
      const point = recoveryPoint(snapshot.recoveryPoint)
      if (point.destination === null || point.parsed === null) return null
      const requestedConfiguration = configuration(await preflightSkillConfiguration(
        request.payload.configuration,
        request.plan.scopeKey,
      ))
      if (point.contentIntegrity !== request.plan.artifactIntegrity
        || point.parsed.name !== request.plan.extensionId
        || canonicalSha256(point.configuration) !== canonicalSha256(requestedConfiguration)) {
        throw new Error('Skill recovery point does not bind the immutable plan')
      }
      const materialBase = resolve(this.root, 'material', 'skills')
      const destinationRelative = relative(materialBase, point.destination)
      if (destinationRelative === '' || destinationRelative === '..' || destinationRelative.startsWith(`..${sep}`)) {
        throw new Error('Skill recovery destination escapes center material')
      }
      let file: string
      try {
        const info = await lstat(point.destination)
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Skill recovered material directory is unsafe')
        file = join(point.destination, 'SKILL.md')
        const fileInfo = await lstat(file)
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('Skill recovered material is unsafe')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (point.stagingPath === null) return null
        const stagingRelative = relative(materialBase, point.stagingPath)
        if (stagingRelative === '' || stagingRelative === '..' || stagingRelative.startsWith(`..${sep}`)) {
          throw new Error('Skill recovery staging path escapes center material')
        }
        const stagingInfo = await lstat(point.stagingPath)
        if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) throw new Error('Skill recovery staging directory is unsafe')
        const stagedFile = join(point.stagingPath, 'SKILL.md')
        const stagedFileInfo = await lstat(stagedFile)
        if (!stagedFileInfo.isFile() || stagedFileInfo.isSymbolicLink()) throw new Error('Skill recovery staged material is unsafe')
        const stagedInspection = await inspectSkillArtifact(stagedFile, point.contentIntegrity)
        if (!stagedInspection.matchesExpected) throw new Error('Skill staged material integrity changed after approval')
        const staged = parseSkill(stagedInspection.text)
        if (staged.name !== point.parsed.name || staged.description !== point.parsed.description) {
          throw new Error('Skill staged material does not match its durable recovery point')
        }
        await mkdir(dirname(point.destination), { recursive: true, mode: 0o700 })
        await rename(point.stagingPath, point.destination)
        file = join(point.destination, 'SKILL.md')
      }
      const recoveredInspection = await inspectSkillArtifact(file, point.contentIntegrity)
      if (!recoveredInspection.matchesExpected) throw new Error('Skill recovered material integrity changed after approval')
      const parsed = parseSkill(recoveredInspection.text)
      if (parsed.name !== point.parsed.name || parsed.description !== point.parsed.description) {
        throw new Error('Skill recovered material does not match its durable recovery point')
      }
      const supplied = immutableJsonClone({
        candidateRef: request.plan.candidateRef,
        artifactRevision: request.plan.artifactRevision,
        artifactIntegrity: request.plan.artifactIntegrity,
        materialPath: file,
        configuration: point.configuration,
        enabled: request.plan.desiredState === 'enabled',
        ownerRevision: request.plan.fences.ownerRevision,
        kindState: {
          skillName: point.parsed.name,
          description: point.parsed.description,
          modelInvocable: point.configuration.modelInvocable,
          userInvocable: point.configuration.userInvocable,
        },
      }) as unknown as ManagedVersion
      const after = nextManagedRecord(snapshot.before, request, supplied, Date.now())
      if (managedStateDigest(current ?? null) !== snapshot.beforeDigest) {
        throw new Error('Skill center state diverged after its material mutation')
      }
      await this.store.putManaged(after, current?.revision ?? 0)
      current = after
      this.invalidate()
    }
    if (request.plan.operationKind === 'purge') await this.removeRetained(snapshot.before)
    const prepared: PreparedProviderOperation = {
      request,
      before: snapshot.before,
      beforeDigest: snapshot.beforeDigest as `sha256:${string}`,
      stagingPath: null,
      prepared: null,
    }
    return Object.freeze({
      prepared,
      mutationDigest: canonicalSha256({ operationId: request.authorization.operationId, after: managedStateDigest(current) }),
      afterDigest: managedStateDigest(current),
      restartRequired: false,
      restartToken: null,
      rollbackRestartRequired: false,
    })
  }

  async cleanup(prepared: PreparedProviderOperation): Promise<void> {
    if (prepared.stagingPath !== null) await rm(prepared.stagingPath, { recursive: true, force: true })
  }

  private async inspectManaged(version: ManagedVersion): Promise<SkillArtifactInspection> {
    const materialBase = resolve(this.root, 'material', 'skills')
    const path = resolve(version.materialPath)
    const rel = relative(materialBase, path)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || path !== version.materialPath) {
      throw new Error('managed Skill material escapes the center root')
    }
    const canonicalBase = await realpath(materialBase)
    const canonicalParent = await realpath(dirname(path))
    const canonicalRel = relative(canonicalBase, canonicalParent)
    if (canonicalRel === '..' || canonicalRel.startsWith(`..${sep}`)) {
      throw new Error('managed Skill parent resolves outside the center root')
    }
    const inspected = await inspectSkillArtifact(path, version.artifactIntegrity)
    if (!inspected.matchesExpected) throw new Error('managed Skill content integrity changed')
    return inspected
  }

  private async removeRetained(before: ManagedTargetRecord | null): Promise<void> {
    const material = new Set([before?.removed?.materialPath, before?.lastGood?.materialPath].filter((path): path is string => path !== undefined))
    for (const path of material) {
      await this.removeMaterial(path)
    }
  }

  private async removeMaterial(path: string): Promise<void> {
    const directory = dirname(path)
    const base = resolve(this.root, 'material', 'skills')
    const rel = relative(base, directory)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('retained Skill path escapes center material')
    const quarantineRoot = join(base, '.removing')
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
    const quarantine = join(quarantineRoot, storageKey(directory))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.removeQuarantine(quarantine, base)
      try {
        await rename(directory, quarantine)
        await this.removeQuarantine(quarantine, base)
        return
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 1) throw error
      }
    }
  }

  private async removeQuarantine(quarantine: string, base: string): Promise<void> {
    let info
    try {
      info = await lstat(quarantine)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      await rm(quarantine, { force: true })
      return
    }
    const canonicalBase = await realpath(base)
    const canonical = await realpath(quarantine)
    const canonicalRel = relative(canonicalBase, canonical)
    if (canonicalRel === '' || canonicalRel === '..' || canonicalRel.startsWith(`..${sep}`)) {
      throw new Error('quarantined Skill material escapes center storage')
    }
    await rm(quarantine, { recursive: true, force: true })
  }
}
