import { useState } from 'react'
import type { RpcJson } from '../service/rpc-contract.ts'
import type { ExtensionCenterKey } from './locales.ts'
import css from './ExtensionCenter.module.css'

/** Exact admitted candidate with a typed resolver configuration adapter. */
export const RESOLVER_CANDIDATE_REF = 'plugin:dsh-capability-resolver@0.1.0'

type Translate = (key: ExtensionCenterKey) => string

const FIELDS = [
  ['freshCacheMs', 1_000, 86_400_000, 900_000],
  ['staleCacheMs', 1_000, 604_800_000, 86_400_000],
  ['fetchTimeoutMs', 100, 60_000, 5_000],
  ['maxCatalogBytes', 65_536, 33_554_432, 8_388_608],
  ['maxCatalogEntries', 1, 20_000, 5_000],
  ['maxTaskChars', 64, 16_000, 2_000],
  ['maxResults', 1, 50, 8],
  ['maxCurrentMatches', 1, 50, 8],
  ['maxMatchedTerms', 1, 50, 12],
  ['maxDescriptionChars', 80, 4_000, 600],
] as const

type ResolverField = typeof FIELDS[number][0]
type ResolverDraft = Readonly<Record<ResolverField, string>>

function initialDraft(value?: RpcJson): ResolverDraft {
  const input = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, RpcJson>>
    : {}
  return Object.fromEntries(FIELDS.map(([name, minimum, maximum, initial]) => {
    const selected = input[name]
    return [name, String(Number.isSafeInteger(selected) && (selected as number) >= minimum && (selected as number) <= maximum
      ? selected
      : initial)]
  })) as unknown as ResolverDraft
}

/** Convert the exact typed draft into the only configuration keys accepted by this Client adapter. */
export function resolverConfiguration(draft: ResolverDraft): RpcJson {
  const output: Record<string, number> = {}
  for (const [name, minimum, maximum] of FIELDS) {
    const value = Number(draft[name])
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(name)
    output[name] = value
  }
  if (output.staleCacheMs! < output.freshCacheMs!) throw new Error('staleCacheMs')
  return output
}

/** Typed staged draft for the admitted capability-resolver configuration adapter. */
export function ResolverConfigDraft({ initial, t, onSave, onDiscard }: {
  readonly initial?: RpcJson
  readonly t: Translate
  readonly onSave: (configuration: RpcJson) => void
  readonly onDiscard: () => void
}) {
  const [draft, setDraft] = useState<ResolverDraft>(() => initialDraft(initial))
  const [error, setError] = useState<string>()
  return (
    <section className={css.configurationDraft} aria-labelledby="resolver-config-draft-heading">
      <h5 id="resolver-config-draft-heading">{t('resolverConfig.heading')}</h5>
      <p>{t('resolverConfig.body')}</p>
      <div className={css.typedConfigGrid}>
        {FIELDS.map(([name, minimum, maximum]) => (
          <label key={name}>
            <span><code>{name}</code></span>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min={minimum}
              max={maximum}
              value={draft[name]}
              aria-describedby={`resolver-config-${name}-constraint`}
              onChange={(event) => {
                const value = event.currentTarget.value
                setDraft(current => ({ ...current, [name]: value }))
              }}
            />
            <small id={`resolver-config-${name}-constraint`}>{minimum}…{maximum}</small>
          </label>
        ))}
      </div>
      <p>{t('resolverConfig.staleRule')}</p>
      {error === undefined ? null : <div role="alert">{t('resolverConfig.invalid')} <code>{error}</code></div>}
      <div className={css.inlineActions}>
        <button type="button" onClick={() => {
          try {
            const configuration = resolverConfiguration(draft)
            setError(undefined)
            onSave(configuration)
          } catch (cause: unknown) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        }}>{t('configure.save')}</button>
        <button type="button" onClick={onDiscard}>{t('configure.discard')}</button>
      </div>
    </section>
  )
}

/** Read-only typed schema shown in candidate details before configuration begins. */
export function ResolverConfigDisclosure({ t }: { readonly t: Translate }) {
  return (
    <section className={css.disclosure} aria-labelledby="resolver-config-schema-heading">
      <h4 id="resolver-config-schema-heading">{t('resolverConfig.schema')}</h4>
      <ul>{FIELDS.map(([name, minimum, maximum]) => (
        <li key={name}>
          <strong><code>{name}</code></strong>
          <span>{t('resolverConfig.integer')} · {minimum}…{maximum}</span>
        </li>
      ))}</ul>
      <p>{t('resolverConfig.staleRule')}</p>
    </section>
  )
}
