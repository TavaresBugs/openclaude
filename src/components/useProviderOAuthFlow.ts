import * as React from 'react'
import { openBrowser } from '../utils/browser.js'
import { isBareMode } from '../utils/envUtils.js'
import { ProviderOAuthService } from '../services/api/providerOAuth.js'
import type { OAuthConfig, OAuthTokensGeneric } from '../services/oauth/types.js'

export type ProviderOAuthFlowStatus =
  | { state: 'starting' }
  | { state: 'waiting_browser'; authUrl: string; browserOpened: boolean | null }
  | { state: 'error'; message: string }

type ProviderOAuthFlowDeps = {
  createService?: () => Pick<ProviderOAuthService, 'startPKCEFlow' | 'cleanup'>
  openBrowser?: typeof openBrowser
  isBareMode?: typeof isBareMode
}

export function useProviderOAuthFlow(options: {
  config: OAuthConfig
  onAuthenticated: (tokens: OAuthTokensGeneric) => void | Promise<void>
  skipBrowserOpen?: boolean
  deps?: ProviderOAuthFlowDeps
}): ProviderOAuthFlowStatus {
  const { config, onAuthenticated } = options
  const createService = options.deps?.createService ?? (() => new ProviderOAuthService())
  const openBrowserFn = options.deps?.openBrowser ?? openBrowser
  const isBareFn = options.deps?.isBareMode ?? isBareMode

  const [status, setStatus] = React.useState<ProviderOAuthFlowStatus>({ state: 'starting' })

  React.useEffect(() => {
    if (isBareFn()) {
      setStatus({
        state: 'error',
        message: `${config.displayName} OAuth unavailable in --bare mode.`,
      })
      return
    }

    let cancelled = false
    const service = createService()

    void service
      .startPKCEFlow(config, async authUrl => {
        if (cancelled) return
        setStatus({ state: 'waiting_browser', authUrl, browserOpened: null })
        if (options.skipBrowserOpen) {
          if (!cancelled) setStatus({ state: 'waiting_browser', authUrl, browserOpened: false })
          return
        }
        const opened = await openBrowserFn(authUrl)
        if (!cancelled) setStatus({ state: 'waiting_browser', authUrl, browserOpened: opened })
      })
      .then(async tokens => {
        if (cancelled) return
        await onAuthenticated(tokens)
      })
      .catch(error => {
        if (cancelled) return
        setStatus({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelled = true
      service.cleanup()
    }
  }, [config, createService, isBareFn, onAuthenticated, openBrowserFn])

  return status
}
