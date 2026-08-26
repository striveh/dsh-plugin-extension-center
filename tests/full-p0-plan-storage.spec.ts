import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, canonicalSha256, ExtensionDomainError } from '../src/domain/index.ts'
import {
  createImmutablePlan,
  type ImmutablePlan,
  type PlanContent,
  type PlanUseContext,
} from '../src/plans/index.ts'
import { FilePlanStore } from '../src/storage/index.ts'
import { TEST_RECOVERY_EXECUTABLE_BINDING } from './support/recovery-binding.ts'
import { testReviewEvidence } from './support/review-evidence.ts'

const roots: string[] = []
const CREATED = 1_000
const EXPIRES = 2_000

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function content(): PlanContent {
  return {
    schemaVersion: 1,
    singleUse: true,
    planId: 'plan:durable:1',
    intentId: 'intent:store:1',
    origin: 'store',
    candidateRef: 'skill:example@1',
    extensionKind: 'skill',
    extensionId: 'example',
    managedObject: 'artifact',
    externalRuntimeAction: 'download',
    runtimeBinding: null,
    artifactRevision: '1',
    artifactIntegrity: canonicalSha256({ artifact: 1 }),
    artifactUrl: 'https://example.test/example.md',
    artifactSizeBytes: 123,
    operationKind: 'install',
    desiredState: 'enabled',
    targetKey: 'skill:user/example',
    ownerKey: 'skill-filesystem:user',
    scopeKey: 'agent:1:/workspace',
    profileId: 'profile:web',
    idempotencyKey: 'idem:1',
    authorityDigest: canonicalSha256({ authority: 1 }),
    configurationDigest: canonicalSha256({ configuration: 1 }),
    retentionDigest: canonicalSha256({ retention: 1 }),
    reviewEvidence: testReviewEvidence('skill', 'install'),
    mutationDigest: canonicalSha256({ mutation: 1 }),
    verificationDigest: canonicalSha256({ verification: 1 }),
    restartRequired: false,
    createdAtMs: CREATED,
    expiresAtMs: EXPIRES,
    fences: {
      catalogRevision: 1,
      inventoryRevision: canonicalSha256({ inventory: 1 }),
      targetRevision: 'target:absent',
      ownerRevision: 'owner:1',
      scopeRevision: 'scope:1',
      profileRevision: 'profile:1',
    },
  }
}

function context(plan: ImmutablePlan): PlanUseContext {
  return {
    operationKind: plan.content.operationKind,
    targetKey: plan.content.targetKey,
    ownerKey: plan.content.ownerKey,
    scopeKey: plan.content.scopeKey,
    profileId: plan.content.profileId,
    fences: plan.content.fences,
  }
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'extension-center-plans-'))
  roots.push(value)
  return value
}

describe('full P0 durable plan store', () => {
  it('survives restart from pending through one decision and one consumption', async () => {
    const data = await root()
    const plan = createImmutablePlan(content())
    const first = new FilePlanStore(data, TEST_RECOVERY_EXECUTABLE_BINDING)
    await expect(first.put(plan)).resolves.toMatchObject({ status: 'pending' })
    await expect(first.put(plan)).resolves.toMatchObject({ status: 'pending' })

    const approved = await new FilePlanStore(data, TEST_RECOVERY_EXECUTABLE_BINDING).decide(plan.hash, {
      planId: plan.content.planId,
      planHash: plan.hash,
      operationKind: plan.content.operationKind,
      decision: 'approve',
    }, context(plan), CREATED + 1)
    expect(approved.status).toBe('approved')

    const consumed = await new FilePlanStore(data, TEST_RECOVERY_EXECUTABLE_BINDING).consume(
      plan.hash,
      'operation:1',
      context(plan),
      CREATED + 2,
    )
    expect(consumed).toMatchObject({ state: { status: 'consumed' }, authorization: { operationId: 'operation:1' } })
    await expect(new FilePlanStore(data, TEST_RECOVERY_EXECUTABLE_BINDING).load(plan.hash)).resolves.toMatchObject({
      status: 'consumed',
      authorization: { operationId: 'operation:1' },
    })
  })

  it('records rejection without creating mutation authorization and rejects replay', async () => {
    const data = await root()
    const plan = createImmutablePlan(content())
    const store = new FilePlanStore(data, TEST_RECOVERY_EXECUTABLE_BINDING)
    await store.put(plan)
    await expect(store.decide(plan.hash, {
      planId: plan.content.planId,
      planHash: plan.hash,
      operationKind: plan.content.operationKind,
      decision: 'reject',
    }, context(plan), CREATED + 1)).resolves.toMatchObject({ status: 'rejected' })
    await expect(store.consume(plan.hash, 'operation:forbidden', context(plan), CREATED + 2))
      .rejects.toMatchObject({ code: 'plan-replay' })
    await expect(store.list()).resolves.toMatchObject([{ status: 'rejected' }])
  })

  it('allows only one concurrent human decision', async () => {
    const data = await root()
    const plan = createImmutablePlan(content())
    const store = new FilePlanStore(data, TEST_RECOVERY_EXECUTABLE_BINDING)
    await store.put(plan)
    const input = {
      planId: plan.content.planId,
      planHash: plan.hash,
      operationKind: plan.content.operationKind,
      decision: 'approve' as const,
    }
    const results = await Promise.allSettled([
      store.decide(plan.hash, input, context(plan), CREATED + 1),
      store.decide(plan.hash, input, context(plan), CREATED + 1),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  it('fails closed on a changed durable decision record', async () => {
    const data = await root()
    const plan = createImmutablePlan(content())
    const store = new FilePlanStore(data, TEST_RECOVERY_EXECUTABLE_BINDING)
    await store.put(plan)
    await store.decide(plan.hash, {
      planId: plan.content.planId,
      planHash: plan.hash,
      operationKind: plan.content.operationKind,
      decision: 'approve',
    }, context(plan), CREATED + 1)
    const planDirectory = join(data, 'plans', (await readdir(join(data, 'plans')))[0]!)
    const decisionPath = join(planDirectory, 'decision.json')
    const record = JSON.parse(await readFile(decisionPath, 'utf8'))
    record.decision.decision = 'reject'
    await writeFile(decisionPath, `${canonicalJson(record)}\n`)
    await expect(new FilePlanStore(data, TEST_RECOVERY_EXECUTABLE_BINDING).load(plan.hash))
      .rejects.toBeInstanceOf(ExtensionDomainError)
  })
})
