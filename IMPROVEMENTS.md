# OpenClaude — Melhorias & Roadmap

> Revisão completa do que foi construído no fork e o plano para polir tudo com padrão sólido.

---

## 1. Contexto: O que mudamos vs. original

O [original (Gitlawb/openclaude)](https://github.com/Gitlawb/openclaude) suportava basicamente Anthropic + OpenAI via env vars.
Nossa fork transformou isso num sistema multi-provider completo.

| Área | Original | Nossa Fork |
|------|----------|------------|
| Providers | ~3 (Anthropic, OpenAI, Gemini básico) | **21 providers** com perfis |
| Configuração | Só env vars manuais | Perfis salvos em `~/.openclaude.json` |
| Model Discovery | Nenhuma | Auto-detect + fetch via `/models` endpoint |
| Runtime switch | Não existia | `/model` → `ProviderModelSwitcher` |
| OAuth | Não existia | Codex OAuth completo (browser flow) |
| Auto-detecção | Não existia | Ollama, Codex, env-var providers |
| Persistência | Nenhuma | Perfil ativo persiste entre sessões |

---

## 2. O que foi construído

### 2.1 Providers — estado atual e capacidade OAuth

> Legenda: ✅ Suporta OAuth | 🔑 Só API Key | 🆓 Sem auth | ⚠️ Inconsistência a corrigir

| Empresa | Produto / Endpoint | Preset ID | Auth Atual | OAuth Possível? | Discovery |
|---------|--------------------|-----------|------------|-----------------|-----------|
| **OpenAI** | API Pública (`api.openai.com/v1`) | `openai` | API Key | — | Dinâmico |
| **OpenAI** | Codex — Endpoint interno ChatGPT (`chatgpt.com/...`) | `codex` | **OAuth + API Key** ✅ | Já implementado | Dinâmico |
| **Google** | Gemini | `gemini` | API Key | ✅ Google OAuth 2.0 | Estático ⚠️ |
| **Alibaba** | Dashscope — China | `dashscope-cn` | API Key | ✅ Device Flow (RFC 8628) | Estático ⚠️ |
| **Alibaba** | Dashscope — Internacional | `dashscope-intl` | API Key | ✅ Device Flow (RFC 8628) | Estático ⚠️ |
| Anthropic | Claude API | `anthropic` | API Key | — (proprietário) | Estático |
| Moonshot AI | Kimi API | `moonshotai` | API Key 🔑 | ✗ | Estático ⚠️ |
| Zhipu AI | GLM API | `glm` | API Key 🔑 | ✗ | Estático |
| DeepSeek | DeepSeek API | `deepseek` | API Key 🔑 | ✗ | Hard-coded ⚠️ |
| Mistral | Mistral API | `mistral` | API Key 🔑 | — | Estático ⚠️ |
| Together AI | Together API | `together` | API Key 🔑 | — | Dinâmico |
| Groq | Groq API | `groq` | API Key 🔑 | — | Dinâmico |
| Microsoft/OpenAI | Azure OpenAI | `azure-openai` | API Key 🔑 | — (Azure AD separado) | Dinâmico |
| OpenRouter | OpenRouter API | `openrouter` | API Key 🔑 | — | Dinâmico |
| NVIDIA | NIM API | `nvidia-nim` | API Key 🔑 | — | Estático ⚠️ |
| MiniMax | MiniMax API | `minimax` | API Key 🔑 | — | Estático ⚠️ |
| Bankr | Bankr LLM | `bankr` | API Key 🔑 | — | Estático ⚠️ |
| LM Studio | Local | `lmstudio` | Nenhuma 🆓 | — | Dinâmico |
| Atomic Chat | Local | `atomic-chat` | Nenhuma 🆓 | — | Dinâmico |
| Ollama | Local | `ollama` | Nenhuma 🆓 | — | Dinâmico |
| — | Qualquer OpenAI-compat. | `custom` | Opcional | — | Dinâmico |

> **Por que `openai` e `codex` são presets separados:**
> Mesma empresa, mas endpoints e auth fundamentalmente diferentes.
> `openai` = API oficial pública, API key padrão, modelos gpt-5.x disponíveis a qualquer assinante.
> `codex` = Endpoint interno do ChatGPT, exige OAuth de conta ChatGPT Plus **ou** CODEX_API_KEY especial, dá acesso a modelos `codexplan`/`codexspark` inexistentes na API pública.
> No UI deverão aparecer agrupados em **"OpenAI"** com escolha do endpoint — previsto na Fase 7.

#### OAuth — O que é possível implementar

**Regra do sistema:** ao escolher o método de auth, o endpoint padrão muda automaticamente.

| Empresa | Preset | Auth Method | Endpoint padrão | Flow | Credenciais |
|---------|--------|-------------|-----------------|------|-------------|
| OpenAI | `codex` | OAuth | `https://chatgpt.com/backend-api/codex` | PKCE | `~/.codex/auth.json` |
| OpenAI | `codex` | API Key | `https://chatgpt.com/backend-api/codex` | — | `CODEX_API_KEY` |
| Google | `gemini` | OAuth | `https://generativelanguage.googleapis.com/v1beta/openai` | PKCE Google | `~/.openclaude/gemini-auth.json` |
| Google | `gemini` | API Key | `https://generativelanguage.googleapis.com/v1beta/openai` | — | `GEMINI_API_KEY` |
| Alibaba | `dashscope-cn` | OAuth | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Device Flow RFC 8628 | `~/.openclaude/dashscope-auth.json` |
| Alibaba | `dashscope-cn` | API Key | `https://coding.dashscope.aliyuncs.com/v1` | — | `DASHSCOPE_API_KEY` |
| Alibaba | `dashscope-intl` | OAuth | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | Device Flow RFC 8628 | `~/.openclaude/dashscope-auth.json` |
| Alibaba | `dashscope-intl` | API Key | `https://coding-intl.dashscope.aliyuncs.com/v1` | — | `DASHSCOPE_API_KEY` |

> Isso precisa refletir na `OAuthConfig`: campo `defaultBaseUrl` por método de auth.
> Quando usuário troca de API Key → OAuth no `ProviderManager`, o `baseUrl` do perfil deve ser atualizado automaticamente.

> Moonshot e GLM **não disponibilizam** OAuth para acesso de API — só API key.

### 2.2 Arquivos novos criados

```
src/utils/providerRegistry.ts                  (321 linhas) — cache/discovery de modelos
src/commands/model/ProviderModelSwitcher.tsx   (184 linhas) — UI de troca runtime
src/utils/model/openaiModelDiscovery.ts        (141 linhas) — fetch dinâmico via /models
```

### 2.3 Arquivos significativamente modificados

```
src/utils/providerProfiles.ts          — 21 presets, Codex OAuth env, GLM adicionado
src/components/ProviderManager.tsx     — redesign completo, OAuth UI
src/commands/provider/provider.tsx     — expansão de presets
src/components/StartupScreen.ts        — detectAuthStatus(), token expiry
src/services/api/codexOAuth.ts         — OAuth flow
src/services/api/codexOAuthShared.ts   — JWT decode, HTML sanitize
src/services/oauth/auth-code-listener.ts — callback pages browser
src/components/useCodexOAuthFlow.ts    — state management OAuth
src/commands/model/model.tsx           — integração ProviderModelSwitcher
```

### 2.4 Infraestrutura técnica adicionada (main branch)

- **Hook Chains** — runtime self-healing agent mesh (`#711`)
- **Streaming optimizer** + structured request logging (`#703`)
- **Model-specific tokenizers** + compression ratio detection (`#799`)
- **Zero-config autodetection** primitive (`#784`)
- **Resilient web search/fetch** cross-provider (`#836`)
- **Thinking token extraction** (`#798`)
- **OPENCLAUDE_DISABLE_TOOL_REMINDERS** env var (`#837`)

---

## 3. Problemas identificados

### ~~P1 — Inconsistência de ModelSource~~ ✅ RESOLVIDO
`modelSource`, `authMethod`, `staticModels[]`, `docsUrl` adicionados a todos os 21 presets.
`providerRegistry` pula fetch para providers estáticos. DeepSeek fix: string solta → `staticModels`.
> commit `5d61739`

### P2 — OAuth não é extensível
Flow OAuth acoplado 100% ao Codex. Gemini e Dashscope têm OAuth disponível mas sem infraestrutura para reaproveitar o padrão.

### P3 — Sem versionamento dos perfis salvos
`~/.openclaude.json` não tem `version`. Mudanças de schema corrompem perfis existentes silenciosamente.

### P4 — Auto-detection com strings mágicas
`__codex_auto__`, `__ollama_auto__` são strings hardcoded espalhadas em `providerRegistry.ts`.
Adicionar novo provider auto-detectável exige editar múltiplos pontos.

### P5 — TTL do cache fixo em 1h
Sem env var para controlar. Usuários com APIs lentas ou redes instáveis não têm como ajustar.

### P6 — Porta OAuth hardcoded (1455)
`localhost:1455` como callback pode colidir com outros processos. Sem fallback para outras portas.

### P7 — Codex client ID hardcoded
`app_EMoamEEZ73f0CkXaXp7hrann` no código-fonte. Deve ir para env var.

### P8 — Cobertura de testes incompleta
`providerRegistry.ts`, `ProviderModelSwitcher.tsx`, `openaiModelDiscovery.ts` sem cobertura adequada.

---

## 4. Roadmap — Checklist de Padronização

### Fase 1 — Fundação do sistema de providers
> Objetivo: Tornar o sistema de providers declarativo e consistente.

- [x] **1.1** Adicionar `modelSource: 'static' | 'openai-models-api'` como campo obrigatório em `ProviderPresetDefaults`
- [x] **1.2** Adicionar `authMethod: 'api-key' | 'oauth' | 'none'` como campo obrigatório
- [x] **1.3** Adicionar `staticModels?: string[]` para providers com lista fixa
- [x] **1.4** Adicionar `docsUrl: string` para link à documentação oficial de cada provider
- [x] **1.5** Migrar DeepSeek para `staticModels: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']`
- [x] **1.6** Migrar NIM, MiniMax, Bankr, Dashscope, Moonshot, GLM para `modelSource: 'static'` com `staticModels`
- [x] **1.7** Garantir que `providerRegistry` usa `modelSource` para decidir fetch vs lista estática
- [ ] **1.8** Adicionar GLM ao `/provider` UI e ao `ProviderManager` (preset já existe em `providerProfiles.ts`)

### Fase 2 — OAuth genérico (Gemini + Dashscope)
> Objetivo: Reaproveitar infraestrutura OAuth do Codex para Gemini e Dashscope.

- [ ] **2.1** Criar `src/services/oauth/types.ts` com interface `OAuthConfig`:
  ```typescript
  interface OAuthConfig {
    providerId: string
    clientId: string
    clientSecret?: string           // Gemini precisa, Codex não
    authorizationUrl: string
    tokenUrl: string
    callbackPort: number
    fallbackPorts: number[]
    scopes: string[]
    credentialsPath: string
    flow: 'pkce' | 'device'         // pkce=Codex/Gemini, device=Dashscope
    defaultBaseUrl: string          // endpoint aplicado automaticamente ao ativar OAuth
  }
  ```
- [ ] **2.2** Mover config Codex para `CODEX_OAUTH_CONFIG: OAuthConfig` usando o novo tipo
- [ ] **2.3** Refatorar `useCodexOAuthFlow.ts` → `useProviderOAuthFlow.ts` que aceita `OAuthConfig`
- [ ] **2.4** Implementar `GEMINI_OAUTH_CONFIG` (Authorization Code + PKCE, Google endpoints)
  - Authorization URL: `https://accounts.google.com/o/oauth2/v2/auth`
  - Token URL: `https://oauth2.googleapis.com/token`
  - Scope: `https://www.googleapis.com/auth/generative-language`
  - Credenciais: `~/.openclaude/gemini-auth.json`
- [ ] **2.5** Implementar `DASHSCOPE_OAUTH_CONFIG` (Device Authorization Grant, RFC 8628)
  - Device URL: `https://signin.aliyun.com/oauth2/v1/device/authorize`
  - Token URL: `https://oauth.aliyun.com/v1/token`
  - Scope: `cloud:llm:read cloud:llm:write`
  - Credenciais: `~/.openclaude/dashscope-auth.json`
  - Fluxo: polling de token até aprovação no browser
- [ ] **2.6** Adicionar UI de OAuth no `ProviderManager` para Gemini (igual ao Codex)
- [ ] **2.7** Adicionar UI de OAuth no `ProviderManager` para Dashscope (Device Flow = mostrar código para usuário)
- [ ] **2.8** Ao trocar API Key → OAuth no `ProviderManager`: aplicar `OAuthConfig.defaultBaseUrl` automaticamente no perfil
- [ ] **2.9** Ao trocar OAuth → API Key: restaurar o `baseUrl` padrão de API Key do preset
- [ ] **2.10** Mover `client_id` Codex para env var `CODEX_OAUTH_CLIENT_ID` com fallback
- [ ] **2.11** Implementar fallback de porta: testar 1455 → 1456 → 1457 antes de falhar
- [ ] **2.12** Testar flow Codex sem regressão após refatoração

### Fase 3 — Persistência versionada
> Objetivo: Perfis salvos sobrevivem a mudanças de schema sem corromper dados.

- [ ] **3.1** Adicionar `version: number` no topo de `~/.openclaude.json`
- [ ] **3.2** Criar `migrateProfiles(raw: unknown, currentVersion: number): ProviderProfile[]`
- [ ] **3.3** Implementar migração v1 → v2: adicionar `modelSource`, `authMethod` com defaults
- [ ] **3.4** Na leitura de perfis: sempre rodar migração antes de usar dados
- [ ] **3.5** Testes de migração: schema v1 → v2 sem perda de dados
- [ ] **3.6** Versionar cache de modelos (`provider-models-cache.json`) — invalidar se schema mudou

### Fase 4 — Auto-detection declarativa
> Objetivo: Adicionar novo provider auto-detectável em 1 lugar, não em 5.

- [ ] **4.1** Criar `AUTO_DETECT_RULES: AutoDetectRule[]` em `providerRegistry.ts`:
  ```typescript
  interface AutoDetectRule {
    syntheticId: string
    displayName: string
    check: () => Promise<boolean | ProviderCredentials>
    buildProfile: (credentials?: unknown) => SyntheticProviderProfile
    priority: number
  }
  ```
- [ ] **4.2** Migrar detecções atuais para o array: Codex, Ollama, OpenAI env, Gemini env, Groq env, DeepSeek env
- [ ] **4.3** Adicionar rule para Gemini OAuth (checar `~/.openclaude/gemini-auth.json`)
- [ ] **4.4** Adicionar rule para Dashscope OAuth (checar `~/.openclaude/dashscope-auth.json`)
- [ ] **4.5** Remover strings mágicas `'__codex_auto__'` etc. — usar constante exportada de cada rule
- [ ] **4.6** Testes unitários para cada `AutoDetectRule.check()` com mocks de env/filesystem
- [ ] **4.7** Env var `OPENCLAUDE_DISABLE_AUTODETECT=codex,ollama` para desabilitar rules específicas

### Fase 5 — Cache configurável e confiável
> Objetivo: Cache de modelos com controle do usuário.

- [ ] **5.1** Env var `OPENCLAUDE_MODEL_CACHE_TTL_SECONDS` (default: 3600)
- [ ] **5.2** Respeitar TTL configurável no `providerRegistry`
- [ ] **5.3** Env var `OPENCLAUDE_DISABLE_MODEL_CACHE=1` para debug
- [ ] **5.4** Mostrar idade do cache no `ProviderModelSwitcher` (ex: "atualizado há 23 min")
- [ ] **5.5** Env var `OPENCLAUDE_MODEL_FETCH_TIMEOUT_MS` (default: 5000)

### Fase 6 — Testes e cobertura
> Objetivo: Todo código novo tem testes.

- [ ] **6.1** `providerRegistry.ts`: auto-detection, cache hit/miss, TTL expirado
- [ ] **6.2** `ProviderModelSwitcher.tsx`: render, seleção, refresh, estado vazio
- [ ] **6.3** `openaiModelDiscovery.ts`: sucesso, timeout, 401, endpoint unreachable
- [ ] **6.4** OAuth Gemini: happy path, token refresh, revogação
- [ ] **6.5** OAuth Dashscope: device flow completo, polling, aprovação/rejeição
- [ ] **6.6** Integração: fluxo completo provider → ativação → modelo selecionado
- [ ] **6.7** Migração: schema `~/.openclaude.json` v1 → v2
- [ ] **6.8** `AUTO_DETECT_RULES` individuais com mocks

### Fase 7 — UX e polish final
> Objetivo: Experiência consistente em todos os pontos de entrada.

- [ ] **7.1** Padronizar mensagens de erro cross-provider
- [ ] **7.2** Mostrar `docsUrl` de cada provider no formulário de setup
- [ ] **7.3** Status de expiração OAuth no banner de startup (Codex, Gemini, Dashscope)
- [ ] **7.4** `/provider status` — mostra provider ativo, modelo, TTL do cache, auth status
- [ ] **7.5** Validação de `baseUrl` antes de salvar (ping rápido ou regex de formato)
- [ ] **7.6** Mensagem clara quando provider ativo fica offline mid-session
- [ ] **7.7** Badge visual no `ProviderModelSwitcher` indicando auth method (🔑 / OAuth / local)

### Fase 8 — Documentação
> Objetivo: Qualquer contribuidor entende o sistema em < 30 min.

- [ ] **8.1** `README.md`: lista dos 21 providers, como configurar cada um, quais suportam OAuth
- [ ] **8.2** `.env.example`: todas as `OPENCLAUDE_*`, `ZHIPUAI_API_KEY`, `GLM_API_KEY`
- [ ] **8.3** `docs/providers.md`: guia de como adicionar novo provider (template)
- [ ] **8.4** `docs/oauth.md`: flows disponíveis (PKCE, Device), como estender para novo provider
- [ ] **8.5** `docs/schema.md`: schema de `~/.openclaude.json` e processo de migração
- [ ] **8.6** `CHANGELOG.md`: todas as features da nossa fork documentadas

---

## 5. Ordem de execução

```
Fase 1 (providers declarativos) ──┐
                                   ├── fazer juntas
Fase 3 (persistência versionada) ──┘
         ↓
Fase 4 (auto-detection declarativa)
         ↓
Fase 2 (OAuth genérico: Gemini + Dashscope)
         ↓
Fase 5 (cache configurável)
         ↓
Fase 6 (testes) ← acompanha cada fase acima
         ↓
Fase 7 (UX polish)
         ↓
Fase 8 (documentação)
```

---

## 6. Definição de "pronto" por provider

Um provider está **padronizado** quando:

- [ ] Tem `modelSource`, `authMethod`, `docsUrl` declarados no preset
- [ ] Se `static`: tem `staticModels[]` com lista atual completa
- [ ] Se `openai-models-api`: testado que `/models` funciona no endpoint
- [ ] Se suporta OAuth: flow implementado e testado (happy path + refresh + erro)
- [ ] Aparece corretamente no `ProviderModelSwitcher`
- [ ] Aparece corretamente no auto-detect (se aplicável)
- [ ] Env vars documentadas no `.env.example`
- [ ] Pelo menos 1 teste cobrindo configuração e ativação

---

## 7. GLM — Referência rápida

Provider adicionado em `src/utils/providerProfiles.ts`:

```
Preset ID  : glm
Nome       : Zhipu AI (GLM)
Endpoint   : https://open.bigmodel.cn/api/paas/v4
Auth       : API Key (ZHIPUAI_API_KEY ou GLM_API_KEY)
OAuth      : Não disponível
Modelos    : glm-4.7, glm-4.6, glm-4.5, glm-4.5-flash (default), glm-4.5-air
Discovery  : static (não tem /models endpoint público)
Docs       : https://open.bigmodel.cn/dev/howuse/model
```

---

*Atualizado em 2026-04-25. Branch: `feat/codex-full-model-list-and-custom-endpoint`*
