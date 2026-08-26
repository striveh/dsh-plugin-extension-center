import { useMemo, useState } from 'react'
import type { ConfigurationRuntimeOption, RpcJson } from '../service/rpc-contract.ts'
import type { ExtensionCenterKey } from './locales.ts'
import css from './ExtensionCenter.module.css'

type Translate = (key: ExtensionCenterKey) => string

function object(value: RpcJson | null): Readonly<Record<string, RpcJson>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, RpcJson>>
    : null
}

function integer(value: string, minimum: number, maximum: number, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(field)
  return parsed
}

function absolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')
}

/** Typed Skill target and invocation configuration. */
export function SkillConfigurationDraft({ scopeKey, initial, t, onSave, onDiscard }: {
  readonly scopeKey: string
  readonly initial: RpcJson | null
  readonly t: Translate
  readonly onSave: (configuration: RpcJson) => void
  readonly onDiscard: () => void
}) {
  const prior = object(initial)
  const [modelInvocable, setModelInvocable] = useState(prior?.modelInvocable !== false)
  const [userInvocable, setUserInvocable] = useState(prior?.userInvocable !== false)
  const [projectRoot, setProjectRoot] = useState(typeof prior?.projectRoot === 'string' ? prior.projectRoot : '')
  const [error, setError] = useState<string>()
  const project = scopeKey === 'project'
  return (
    <section className={css.configurationDraft} aria-labelledby="skill-config-draft-heading">
      <h5 id="skill-config-draft-heading">{t('skillConfig.heading')}</h5>
      <p>{t('skillConfig.body')}</p>
      {project ? (
        <label>
          <span>{t('skillConfig.projectRoot')}</span>
          <input value={projectRoot} onChange={(event) => { setProjectRoot(event.currentTarget.value) }} />
          <small>{t('skillConfig.projectRoot.body')}</small>
        </label>
      ) : null}
      <label><input type="checkbox" checked={modelInvocable} onChange={(event) => { setModelInvocable(event.currentTarget.checked) }} /> {t('skillConfig.modelInvocable')}</label>
      <label><input type="checkbox" checked={userInvocable} onChange={(event) => { setUserInvocable(event.currentTarget.checked) }} /> {t('skillConfig.userInvocable')}</label>
      {error === undefined ? null : <div role="alert">{t('configure.invalid')} <code>{error}</code></div>}
      <div className={css.inlineActions}>
        <button type="button" onClick={() => {
          const root = projectRoot.trim()
          if (project && (!absolutePath(root) || root.includes('\0'))) {
            setError('projectRoot')
            return
          }
          setError(undefined)
          onSave({ modelInvocable, userInvocable, projectRoot: project ? root : null })
        }}>{t('configure.save')}</button>
        <button type="button" onClick={onDiscard}>{t('configure.discard')}</button>
      </div>
    </section>
  )
}

/** Typed MCP connection over one Host-provisioned runtime selector. */
export function McpConfigurationDraft({ options, initial, t, onSave, onDiscard }: {
  readonly options: readonly ConfigurationRuntimeOption[]
  readonly initial: RpcJson | null
  readonly t: Translate
  readonly onSave: (configuration: RpcJson) => void
  readonly onDiscard: () => void
}) {
  const prior = object(initial)
  const reconnect = object((prior?.reconnect ?? null) as RpcJson | null)
  const initialRuntime = typeof prior?.runtimeRef === 'string' && options.some(option => option.runtimeRef === prior.runtimeRef)
    ? prior.runtimeRef
    : options[0]?.runtimeRef ?? ''
  const [runtimeRef, setRuntimeRef] = useState(initialRuntime)
  const [connectionId, setConnectionId] = useState(typeof prior?.connectionId === 'string' ? prior.connectionId : 'filesystem')
  const [roots, setRoots] = useState(Array.isArray(prior?.roots) && prior.roots.every(root => typeof root === 'string')
    ? prior.roots.join('\n')
    : '')
  const [toolCallTimeoutMs, setToolCallTimeoutMs] = useState(String(typeof prior?.toolCallTimeoutMs === 'number' ? prior.toolCallTimeoutMs : 30_000))
  const [reconnectEnabled, setReconnectEnabled] = useState(reconnect?.enabled !== false)
  const [initialDelayMs, setInitialDelayMs] = useState(String(typeof reconnect?.initialDelayMs === 'number' ? reconnect.initialDelayMs : 250))
  const [maxDelayMs, setMaxDelayMs] = useState(String(typeof reconnect?.maxDelayMs === 'number' ? reconnect.maxDelayMs : 5_000))
  const [maxAttempts, setMaxAttempts] = useState(String(typeof reconnect?.maxAttempts === 'number' ? reconnect.maxAttempts : 8))
  const [error, setError] = useState<string>()
  const selected = useMemo(() => options.find(option => option.runtimeRef === runtimeRef), [options, runtimeRef])

  return (
    <section className={css.configurationDraft} aria-labelledby="mcp-config-draft-heading">
      <h5 id="mcp-config-draft-heading">{t('mcpConfig.heading')}</h5>
      <p>{t('mcpConfig.body')}</p>
      {options.length === 0 ? <div role="alert"><strong>{t('mcpConfig.runtimeMissing')}</strong><p>{t('mcpConfig.runtimeMissing.body')}</p></div> : (
        <>
          <label><span>{t('mcpConfig.runtime')}</span><select value={runtimeRef} onChange={(event) => { setRuntimeRef(event.currentTarget.value) }}>
            {options.map(option => <option key={option.runtimeRef} value={option.runtimeRef}>{option.runtimeRef} · {option.version} · {option.transport}</option>)}
          </select></label>
          <label><span>{t('mcpConfig.connectionId')}</span><input value={connectionId} maxLength={32} onChange={(event) => { setConnectionId(event.currentTarget.value) }} /></label>
          {selected?.transport === 'stdio' ? (
            <>
              <p><strong>{t('mcpConfig.executable')}</strong> <code>{selected.executablePath}</code></p>
              <p><strong>{t('mcpConfig.arguments')}</strong> <code>{selected.fixedArgs.join(' ') || t('mcpConfig.none')}</code></p>
              <p><strong>{t('mcpConfig.workingDirectory')}</strong> <code>{selected.workingDirectory}</code></p>
              <label><span>{t('mcpConfig.roots')}</span><textarea value={roots} onChange={(event) => { setRoots(event.currentTarget.value) }} /><small>{t('mcpConfig.roots.body')}</small></label>
            </>
          ) : selected?.transport === 'streamable-http' ? (
            <aside>
              <p><strong>{t('mcpConfig.origin')}</strong> <code>{selected.origin}</code></p>
              <p><strong>{t('mcpConfig.endpoint')}</strong> <code>{selected.endpoint}</code></p>
              <p><strong>{t('mcpConfig.dataEgress')}</strong> {selected.dataEgressDisclosure}</p>
              <p>{t('mcpConfig.httpPolicy')}</p>
            </aside>
          ) : null}
          <label><span>{t('mcpConfig.timeout')}</span><input type="number" min="100" max="300000" step="1" value={toolCallTimeoutMs} onChange={(event) => { setToolCallTimeoutMs(event.currentTarget.value) }} /></label>
          <label><input type="checkbox" checked={reconnectEnabled} onChange={(event) => { setReconnectEnabled(event.currentTarget.checked) }} /> {t('mcpConfig.reconnect')}</label>
          <div className={css.typedConfigGrid}>
            <label><span>{t('mcpConfig.initialDelay')}</span><input type="number" min="50" max="60000" step="1" value={initialDelayMs} onChange={(event) => { setInitialDelayMs(event.currentTarget.value) }} /></label>
            <label><span>{t('mcpConfig.maxDelay')}</span><input type="number" min="50" max="300000" step="1" value={maxDelayMs} onChange={(event) => { setMaxDelayMs(event.currentTarget.value) }} /></label>
            <label><span>{t('mcpConfig.maxAttempts')}</span><input type="number" min="1" max="100" step="1" value={maxAttempts} onChange={(event) => { setMaxAttempts(event.currentTarget.value) }} /></label>
          </div>
          <p>{t('mcpConfig.selected')} <code>{selected?.candidateRef ?? runtimeRef}</code></p>
        </>
      )}
      {error === undefined ? null : <div role="alert">{t('configure.invalid')} <code>{error}</code></div>}
      <div className={css.inlineActions}>
        <button type="button" disabled={options.length === 0} onClick={() => {
          try {
            if (!/^[A-Za-z0-9_-]{1,32}$/u.test(connectionId) || selected === undefined) throw new Error('connectionId/runtimeRef')
            const initialDelay = integer(initialDelayMs, 50, 60_000, 'initialDelayMs')
            const maxDelay = integer(maxDelayMs, 50, 300_000, 'maxDelayMs')
            if (initialDelay > maxDelay) throw new Error('reconnect delay')
            setError(undefined)
            const common = {
              connectionId,
              runtimeRef,
              toolCallTimeoutMs: integer(toolCallTimeoutMs, 100, 300_000, 'toolCallTimeoutMs'),
              reconnect: {
                enabled: reconnectEnabled,
                initialDelayMs: initialDelay,
                maxDelayMs: maxDelay,
                maxAttempts: integer(maxAttempts, 1, 100, 'maxAttempts'),
              },
            }
            if (selected.transport === 'stdio') {
              const canonicalRoots = [...new Set(roots.split(/\r?\n/u).map(root => root.trim()).filter(Boolean))]
              if (canonicalRoots.length === 0 || canonicalRoots.length > 16 || canonicalRoots.some(root => !absolutePath(root) || root.includes('\0'))) throw new Error('roots')
              onSave({ ...common, roots: canonicalRoots, transport: 'stdio' })
            } else {
              onSave({ ...common, transport: 'streamable-http' })
            }
          } catch (cause: unknown) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        }}>{t('configure.save')}</button>
        <button type="button" onClick={onDiscard}>{t('configure.discard')}</button>
      </div>
    </section>
  )
}
