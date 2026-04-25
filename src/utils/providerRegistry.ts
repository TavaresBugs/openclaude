import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  fetchModelsForProvider,
  type ProviderModelOption,
  WELL_KNOWN_PROVIDER_BASE_URLS,
} from './model/openaiModelDiscovery.js'
import { probeOllamaGenerationReadiness } from './providerDiscovery.js'
import { isCodexBaseUrl } from '../services/api/providerConfig.js'
import {
  getProviderProfiles,
  getActiveProviderProfile,
  applyProviderProfileToProcessEnv,
  getStaticModelsForBaseUrl,
} from './providerProfiles.js'
import type { ProviderProfile } from './config.js'
import { resolveCodexApiCredentials } from '../services/api/providerConfig.js'

type CacheRefreshListener = () => void
const cacheRefreshListeners: Set<CacheRefreshListener> = new Set()

export function onProviderCacheRefresh(fn: CacheRefreshListener): () => void {
  cacheRefreshListeners.add(fn)
  return () => cacheRefreshListeners.delete(fn)
}

function notifyCacheRefresh(): void {
  for (const fn of cacheRefreshListeners) fn()
}

export type ProviderModelEntry = {
  model: string
  label: string
  description?: string
  profile: ProviderProfile
}

export type ProviderGroup = {
  providerId: string
  providerName: string
  isActive: boolean
  models: ProviderModelEntry[]
}

function codexAuthExists(): boolean {
  const authPath = join(homedir(), '.codex', 'auth.json')
  return existsSync(authPath)
}

function buildSyntheticProfile(options: {
  id: string
  name: string
  provider: 'openai' | 'anthropic'
  baseUrl: string
  model: string
  apiKey?: string
}): ProviderProfile {
  return {
    id: options.id,
    name: options.name,
    provider: options.provider,
    baseUrl: options.baseUrl,
    model: options.model,
    apiKey: options.apiKey,
  } as ProviderProfile
}

type CodexAutoCredentials = {
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  idToken?: string
} | null | undefined

function getCodexAutoProfile(
  credentials?: CodexAutoCredentials,
): ProviderProfile | null {
  if (credentials === null) return null
  if (credentials === undefined && !codexAuthExists()) return null

  const resolvedCredentials = credentials
    ? { apiKey: credentials.apiKey ?? credentials.accessToken ?? credentials.idToken }
    : resolveCodexApiCredentials(process.env)

  return buildSyntheticProfile({
    id: '__codex_auto__',
    name: 'OpenAI / Codex OAuth - Assinatura',
    provider: 'openai',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
    apiKey: resolvedCredentials.apiKey || undefined,
  })
}

type WellKnownProviderSpec = {
  id: string
  name: string
  provider: 'openai' | 'anthropic'
  envKey: string
  baseUrlKey: keyof typeof WELL_KNOWN_PROVIDER_BASE_URLS
}

const WELL_KNOWN_ENV_PROVIDERS: WellKnownProviderSpec[] = [
  { id: '__anthropic_auto__', name: 'Anthropic (Claude)', provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', baseUrlKey: 'anthropic' },
  { id: '__openai_auto__', name: 'OpenAI', provider: 'openai', envKey: 'OPENAI_API_KEY', baseUrlKey: 'openai' },
  { id: '__gemini_auto__', name: 'Google Gemini', provider: 'openai', envKey: 'GEMINI_API_KEY', baseUrlKey: 'gemini' },
  { id: '__groq_auto__', name: 'Groq', provider: 'openai', envKey: 'GROQ_API_KEY', baseUrlKey: 'groq' },
  { id: '__deepseek_auto__', name: 'DeepSeek', provider: 'openai', envKey: 'DEEPSEEK_API_KEY', baseUrlKey: 'deepseek' },
  { id: '__mistral_auto__', name: 'Mistral', provider: 'openai', envKey: 'MISTRAL_API_KEY', baseUrlKey: 'mistral' },
  { id: '__minimax_auto__', name: 'MiniMax', provider: 'openai', envKey: 'MINIMAX_API_KEY', baseUrlKey: 'minimax' },
]

function getWellKnownEnvProfiles(savedProfiles: ProviderProfile[]): ProviderProfile[] {
  const results: ProviderProfile[] = []
  for (const spec of WELL_KNOWN_ENV_PROVIDERS) {
    const apiKey = process.env[spec.envKey]?.trim()
    if (!apiKey) continue
    const baseUrl = WELL_KNOWN_PROVIDER_BASE_URLS[spec.baseUrlKey] ?? ''
    const alreadySaved = savedProfiles.some(p => p.baseUrl === baseUrl)
    if (alreadySaved) continue
    // Gemini env may overlap with GOOGLE_API_KEY; check alternate for Gemini
    results.push(buildSyntheticProfile({
      id: spec.id,
      name: spec.name,
      provider: spec.provider,
      baseUrl,
      model: '',
      apiKey,
    }))
  }
  // Also check GOOGLE_API_KEY as Gemini fallback
  if (!results.some(p => p.id === '__gemini_auto__')) {
    const googleKey = process.env.GOOGLE_API_KEY?.trim()
    if (googleKey) {
      const baseUrl = WELL_KNOWN_PROVIDER_BASE_URLS['gemini'] ?? ''
      const alreadySaved = savedProfiles.some(p => p.baseUrl === baseUrl)
      if (!alreadySaved) {
        results.push(buildSyntheticProfile({
          id: '__gemini_auto__',
          name: 'Google Gemini',
          provider: 'openai',
          baseUrl,
          model: '',
          apiKey: googleKey,
        }))
      }
    }
  }
  return results
}

async function getOllamaAutoProfile(): Promise<ProviderProfile | null> {
  try {
    const readiness = await probeOllamaGenerationReadiness()
    if (readiness.state !== 'ready' || readiness.models.length === 0) return null

    return buildSyntheticProfile({
      id: '__ollama_auto__',
      name: 'Ollama (local)',
      provider: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      model: readiness.models[0]?.name ?? 'llama3.1:8b',
    })
  } catch {
    return null
  }
}

function providerNameFromProfile(profile: ProviderProfile): string {
  const url = profile.baseUrl.toLowerCase()
  if (isCodexBaseUrl(profile.baseUrl)) return 'OpenAI / Codex OAuth - Assinatura'
  if (url.includes('openrouter')) return 'OpenRouter'
  if (url.includes('localhost') || url.includes('127.0.0.1')) return 'Ollama (local)'
  if (url.includes('anthropic')) return 'Anthropic'
  if (url.includes('gemini') || url.includes('googleapis')) return 'Google Gemini'
  if (url.includes('mistral')) return 'Mistral'
  if (url.includes('groq')) return 'Groq'
  if (url.includes('deepseek')) return 'DeepSeek'
  if (url.includes('openai.com')) return 'OpenAI'
  return profile.name
}

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const CACHE_PATH = join(homedir(), '.claude', 'provider-models-cache.json')

type CacheEntry = {
  models: ProviderModelOption[]
  fetchedAt: number
}

type CacheStore = Record<string, CacheEntry>

function cacheKey(baseUrl: string, apiKey?: string): string {
  return createHash('sha256')
    .update(`${baseUrl}::${apiKey ?? ''}`)
    .digest('hex')
    .slice(0, 16)
}

function readCache(): CacheStore {
  try {
    if (!existsSync(CACHE_PATH)) return {}
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as CacheStore
  } catch {
    return {}
  }
}

function writeCache(store: CacheStore): void {
  try {
    mkdirSync(join(homedir(), '.claude'), { recursive: true })
    writeFileSync(CACHE_PATH, JSON.stringify(store, null, 2), 'utf8')
  } catch {
    // non-critical
  }
}

async function fetchModelsForProfile(
  profile: ProviderProfile,
): Promise<ProviderModelOption[]> {
  const staticModels = getStaticModelsForBaseUrl(profile.baseUrl)
  if (staticModels) {
    return staticModels.map(id => ({ value: id, label: id, description: '' }))
  }

  const key = cacheKey(profile.baseUrl, profile.apiKey)
  const store = readCache()
  const cached = store[key]
  const now = Date.now()

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    void fetchModelsForProvider({ baseUrl: profile.baseUrl, apiKey: profile.apiKey })
      .then(fresh => {
        if (fresh.length > 0) {
          const prevModels = readCache()[key]?.models ?? []
          const changed = fresh.length !== prevModels.length ||
            fresh.some((m, i) => m.value !== prevModels[i]?.value)
          writeCache({ ...readCache(), [key]: { models: fresh, fetchedAt: Date.now() } })
          if (changed) notifyCacheRefresh()
        }
      })
      .catch(() => {})
    return cached.models
  }

  const models = await fetchModelsForProvider({
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
  })

  if (models.length > 0) {
    writeCache({ ...store, [key]: { models, fetchedAt: now } })
  }

  return models
}

export async function getAvailableProviderGroups(options?: {
  codexCredentials?: CodexAutoCredentials
}): Promise<ProviderGroup[]> {
  const savedProfiles = getProviderProfiles()
  const activeProfile = getActiveProviderProfile()

  const profileList: ProviderProfile[] = [...savedProfiles]

  const isCodexSaved = savedProfiles.some(p => isCodexBaseUrl(p.baseUrl))
  const isOllamaSaved = savedProfiles.some(
    p => p.baseUrl.includes('localhost') || p.baseUrl.includes('127.0.0.1'),
  )

  const [codexAuto, ollamaAuto] = await Promise.all([
    isCodexSaved ? null : getCodexAutoProfile(options?.codexCredentials),
    isOllamaSaved ? null : getOllamaAutoProfile(),
  ])

  if (codexAuto) profileList.unshift(codexAuto)
  if (ollamaAuto) profileList.push(ollamaAuto)

  const wellKnownProfiles = getWellKnownEnvProfiles(savedProfiles)
  profileList.push(...wellKnownProfiles)

  const groups = await Promise.all(
    profileList.map(async profile => {
      const models = await fetchModelsForProfile(profile)
      const entries: ProviderModelEntry[] = models.map(m => ({
        model: m.value,
        label: m.label,
        description: m.description,
        profile: { ...profile, model: m.value },
      }))

      return {
        providerId: profile.id,
        providerName: providerNameFromProfile(profile),
        isActive: activeProfile?.id === profile.id,
        models: entries,
      } satisfies ProviderGroup
    }),
  )

  return groups.filter(g => g.models.length > 0)
}

export function hotswapToProvider(profile: ProviderProfile, model: string): void {
  const targetProfile: ProviderProfile = { ...profile, model }
  applyProviderProfileToProcessEnv(targetProfile)
}

export async function prefetchProviderModelsCache(): Promise<void> {
  const savedProfiles = getProviderProfiles()
  const isCodexSaved = savedProfiles.some(p => isCodexBaseUrl(p.baseUrl))
  const profileList: ProviderProfile[] = [...savedProfiles]

  if (!isCodexSaved) {
    const codexAuto = await getCodexAutoProfile()
    if (codexAuto) profileList.unshift(codexAuto)
  }

  profileList.push(...getWellKnownEnvProfiles(savedProfiles))

  await Promise.allSettled(
    profileList.map(profile => fetchModelsForProfile(profile)),
  )
}
