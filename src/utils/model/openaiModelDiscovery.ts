import axios from 'axios'
import { logForDebugging } from '../debug.js'
import type { ModelOption } from './modelOptions.js'
import { getAPIProvider } from './providers.js'

const DISCOVERY_TIMEOUT_MS = 5000
const DISCOVERED_MODEL_DESCRIPTION =
  'Discovered from OpenAI-compatible endpoint'

type OpenAIModelsResponse = {
  data?: Array<{
    id?: string | null
  }>
}

type OllamaTagsResponse = {
  models?: Array<{
    name?: string | null
  }>
}

function getNormalizedOpenAIBaseUrl(): string {
  return (
    process.env.OPENAI_BASE_URL ??
    process.env.OPENAI_API_BASE ??
    'https://api.openai.com/v1'
  ).replace(/\/+$/, '')
}

function isAzureOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return (
      hostname.endsWith('.openai.azure.com') ||
      hostname.endsWith('.cognitiveservices.azure.com')
    )
  } catch {
    return false
  }
}

function isBankrBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes('bankr')
  } catch {
    return false
  }
}

function getOpenAIAuthHeaders(baseUrl: string): Record<string, string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return {}
  }

  if (isBankrBaseUrl(baseUrl)) {
    return { 'X-API-Key': apiKey }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  }

  if (isAzureOpenAIBaseUrl(baseUrl)) {
    headers['api-key'] = apiKey
  }

  return headers
}

function getModelListUrls(baseUrl: string): string[] {
  const primary = baseUrl.endsWith('/v1')
    ? `${baseUrl}/models`
    : `${baseUrl}/v1/models`
  const secondary = `${baseUrl}/models`

  const apiVersion = process.env.OPENAI_API_VERSION?.trim()
  const addApiVersion =
    apiVersion && isAzureOpenAIBaseUrl(baseUrl)
      ? (url: string): string => {
          try {
            const parsed = new URL(url)
            parsed.searchParams.set('api-version', apiVersion)
            return parsed.toString()
          } catch {
            return url
          }
        }
      : (url: string): string => url

  if (primary === secondary) {
    return [addApiVersion(primary)]
  }

  return [addApiVersion(primary), addApiVersion(secondary)]
}

function getOllamaTagsUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl)
    const normalizedPath = parsed.pathname.replace(/\/+$/, '')
    const pathPrefix = normalizedPath.endsWith('/v1')
      ? normalizedPath.slice(0, -3)
      : normalizedPath
    const tagsPath = `${pathPrefix}/api/tags`.replace(/\/{2,}/g, '/')
    return `${parsed.origin}${tagsPath}`
  } catch {
    return null
  }
}

function uniqueModelNames(modelNames: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const modelName of modelNames) {
    const trimmed = modelName.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    unique.push(trimmed)
  }

  return unique
}

async function fetchOpenAIModels(
  urls: string[],
  headers: Record<string, string>,
): Promise<string[]> {
  for (const url of urls) {
    try {
      const response = await axios.get<OpenAIModelsResponse>(url, {
        headers,
        timeout: DISCOVERY_TIMEOUT_MS,
      })
      const modelNames = uniqueModelNames(
        (response.data?.data ?? [])
          .map(model => model.id ?? '')
          .filter((model): model is string => model.length > 0),
      )
      if (modelNames.length > 0) {
        return modelNames
      }
    } catch {
      logForDebugging(`[ModelDiscovery] Failed to fetch OpenAI models from ${url}`)
    }
  }

  return []
}

async function fetchOllamaModels(
  url: string,
  headers: Record<string, string>,
): Promise<string[]> {
  try {
    const response = await axios.get<OllamaTagsResponse>(url, {
      headers,
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    return uniqueModelNames(
      (response.data?.models ?? [])
        .map(model => model.name ?? '')
        .filter((model): model is string => model.length > 0),
    )
  } catch {
    logForDebugging(`[ModelDiscovery] Failed to fetch Ollama models from ${url}`)
    return []
  }
}

export async function discoverOpenAICompatibleModelOptions(): Promise<
  ModelOption[]
> {
  if (getAPIProvider() !== 'openai') {
    return []
  }

  const baseUrl = getNormalizedOpenAIBaseUrl()
  const headers = getOpenAIAuthHeaders(baseUrl)

  let discoveredModelNames = await fetchOpenAIModels(
    getModelListUrls(baseUrl),
    headers,
  )

  if (discoveredModelNames.length === 0) {
    const ollamaTagsUrl = getOllamaTagsUrl(baseUrl)
    if (ollamaTagsUrl) {
      discoveredModelNames = await fetchOllamaModels(ollamaTagsUrl, headers)
    }
  }

  return discoveredModelNames.map(modelName => ({
    value: modelName,
    label: modelName,
    description: DISCOVERED_MODEL_DESCRIPTION,
  }))
}

export const WELL_KNOWN_PROVIDER_MODELS: Record<string, Array<{ value: string; label: string; description: string }>> = {
  anthropic: [
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7', description: 'Most capable Claude model, highest intelligence' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Balanced performance and speed' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Fast and compact, ideal for simple tasks' },
    { value: 'claude-opus-4-5', label: 'Claude Opus 4.5', description: 'Previous generation Opus' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o', description: 'Flagship GPT-4o multimodal model' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'Small and affordable GPT-4o variant' },
    { value: 'o3', label: 'o3', description: 'High reasoning model for complex tasks' },
    { value: 'o4-mini', label: 'o4-mini', description: 'Fast high-reasoning model' },
    { value: 'gpt-4.1', label: 'GPT-4.1', description: 'Latest GPT-4.1 with extended context' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Efficient GPT-4.1 variant' },
  ],
  gemini: [
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', description: 'Fast and versatile Gemini 2.0 model' },
    { value: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', description: 'Lightweight Gemini 2.0 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Most capable Gemini model' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', description: 'Gemini 1.5 Pro with 2M context' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', description: 'Fast Gemini 1.5 model' },
  ],
  groq: [
    { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Versatile)', description: 'Fast Llama 3.3 70B via Groq' },
    { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (Instant)', description: 'Ultra-fast Llama 3.1 8B via Groq' },
    { value: 'gemma2-9b-it', label: 'Gemma 2 9B IT', description: 'Google Gemma 2 9B instruction-tuned' },
    { value: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B', description: 'Mixtral MoE with 32k context via Groq' },
    { value: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill 70B', description: 'DeepSeek R1 reasoning on Groq' },
  ],
  deepseek: [
    { value: 'deepseek-chat', label: 'DeepSeek Chat (V3)', description: 'DeepSeek V3, strong coding model' },
    { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)', description: 'DeepSeek R1 with extended reasoning' },
  ],
  mistral: [
    { value: 'mistral-large-latest', label: 'Mistral Large', description: 'Most capable Mistral model' },
    { value: 'mistral-medium-latest', label: 'Mistral Medium', description: 'Balanced Mistral model' },
    { value: 'mistral-small-latest', label: 'Mistral Small', description: 'Fast and affordable Mistral model' },
    { value: 'codestral-latest', label: 'Codestral', description: 'Mistral code-specialized model' },
    { value: 'mistral-nemo', label: 'Mistral Nemo', description: 'Compact multilingual model' },
  ],
  minimax: [
    { value: 'MiniMax-Text-01', label: 'MiniMax Text-01', description: 'MiniMax flagship text model' },
    { value: 'abab6.5s-chat', label: 'MiniMax ABAB 6.5s', description: 'Fast MiniMax chat model' },
  ],
}

export const WELL_KNOWN_PROVIDER_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  minimax: 'https://api.minimax.chat/v1',
}

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

const CODEX_PROVIDER_MODELS: Array<{ value: string; label: string; description: string }> = [
  { value: 'codexplan', label: 'codexplan — GPT-5.5 (Recommended)', description: 'GPT-5.5 with high reasoning' },
  { value: 'gpt-5.5-mini', label: 'gpt-5.5-mini', description: 'GPT-5.5 Mini, medium reasoning' },
  { value: 'codexspark', label: 'codexspark — GPT-5.3 Spark', description: 'Fast Codex Spark profile' },
  { value: 'gpt-5.4', label: 'gpt-5.4', description: 'GPT-5.4 with high reasoning' },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini', description: 'GPT-5.4 Mini, medium reasoning' },
  { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex', description: 'GPT-5.3 Codex with high reasoning' },
  { value: 'gpt-5.2-codex', label: 'gpt-5.2-codex', description: 'GPT-5.2 Codex with high reasoning' },
  { value: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max', description: 'GPT-5.1 Codex Max with high reasoning' },
  { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini', description: 'GPT-5.1 Codex Mini, fast responses' },
]

function isCodexUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl)
    return parsed.hostname === 'chatgpt.com' && parsed.pathname.replace(/\/+$/, '') === '/backend-api/codex'
  } catch {
    return false
  }
}

function isOllamaUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}

export type ProviderModelOption = {
  value: string
  label: string
  description: string
}

function detectWellKnownProvider(baseUrl: string): string | null {
  const normalized = baseUrl.replace(/\/+$/, '').toLowerCase()
  if (normalized.includes('anthropic.com')) return 'anthropic'
  if (normalized.includes('generativelanguage.googleapis.com') || normalized.includes('gemini')) return 'gemini'
  if (normalized.includes('groq.com')) return 'groq'
  if (normalized.includes('deepseek.com')) return 'deepseek'
  if (normalized.includes('mistral.ai')) return 'mistral'
  if (normalized.includes('minimax.chat')) return 'minimax'
  if (normalized.includes('openai.com')) return 'openai'
  return null
}

export async function fetchModelsForProvider(options: {
  baseUrl: string
  apiKey?: string
}): Promise<ProviderModelOption[]> {
  const { baseUrl, apiKey } = options
  const normalizedUrl = baseUrl.replace(/\/+$/, '')

  if (isCodexUrl(normalizedUrl)) {
    return CODEX_PROVIDER_MODELS
  }

  const wellKnown = detectWellKnownProvider(normalizedUrl)
  if (wellKnown && WELL_KNOWN_PROVIDER_MODELS[wellKnown]) {
    return WELL_KNOWN_PROVIDER_MODELS[wellKnown]
  }

  const headers: Record<string, string> = {}
  const key = apiKey?.trim() || process.env.OPENAI_API_KEY?.trim()
  if (key) {
    headers['Authorization'] = `Bearer ${key}`
  }

  if (isOllamaUrl(normalizedUrl)) {
    const ollamaTagsUrl = getOllamaTagsUrl(normalizedUrl)
    if (ollamaTagsUrl) {
      const models = await fetchOllamaModels(ollamaTagsUrl, headers)
      return models.map(m => ({ value: m, label: m, description: 'Local Ollama model' }))
    }
    return []
  }

  const models = await fetchOpenAIModels(getModelListUrls(normalizedUrl), headers)
  return models.map(m => ({ value: m, label: m, description: DISCOVERED_MODEL_DESCRIPTION }))
}