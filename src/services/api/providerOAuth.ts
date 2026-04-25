import { AuthCodeListener } from '../oauth/auth-code-listener.js'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../oauth/crypto.js'
import { escapeHtml } from './codexOAuthShared.js'
import type {
  OAuthConfig,
  OAuthTokensGeneric,
  DeviceAuthorizationResponse,
} from '../oauth/types.js'

async function tryStartListener(
  callbackPath: string,
  ports: number[],
): Promise<{ listener: AuthCodeListener; port: number }> {
  for (const port of ports) {
    const listener = new AuthCodeListener(callbackPath)
    try {
      const actualPort = await listener.start(port)
      return { listener, port: actualPort }
    } catch {
      // port busy — try next
    }
  }
  throw new Error(
    `Could not bind OAuth callback server on any of: ${ports.join(', ')}`,
  )
}

function renderPage(title: string, heading: string, body: string, headingColor = '#111827'): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: sans-serif; padding: 32px; line-height: 1.5; color: #111827; }
      h1 { margin: 0 0 12px; font-size: 22px; color: ${headingColor}; }
      p { margin: 0 0 10px; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(heading)}</h1>
    ${body}
  </body>
</html>`
}

export class ProviderOAuthService {
  private authCodeListener: AuthCodeListener | null = null
  private tokenExchangeAbortController: AbortController | null = null

  async startPKCEFlow(
    config: OAuthConfig,
    authURLHandler: (authUrl: string) => Promise<void>,
  ): Promise<OAuthTokensGeneric> {
    const ports = [config.callbackPort, ...config.fallbackPorts]
    const { listener, port } = await tryStartListener(config.callbackPath, ports)
    this.authCodeListener = listener

    listener.closeAfter(config.timeoutMs)

    const codeVerifier = generateCodeVerifier()
    const state = generateState()
    const codeChallenge = await generateCodeChallenge(codeVerifier)

    const redirectUri = `http://localhost:${port}${config.callbackPath}`
    const authUrl = new URL(config.authorizationUrl)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', config.clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('scope', config.scopes.join(' '))
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('state', state)

    try {
      const authorizationCode = await listener.waitForAuthorization(
        state,
        async () => { await authURLHandler(authUrl.toString()) },
      )

      const ac = new AbortController()
      this.tokenExchangeAbortController = ac

      let tokens: OAuthTokensGeneric
      try {
        tokens = await this.exchangeCode({
          config,
          authorizationCode,
          codeVerifier,
          redirectUri,
          signal: ac.signal,
        })
      } finally {
        if (this.tokenExchangeAbortController === ac) {
          this.tokenExchangeAbortController = null
        }
      }

      if (listener.hasPendingResponse()) {
        listener.handleSuccessRedirect([], (res, _scopes) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderPage(
            `${config.displayName} Login Complete`,
            `${config.displayName} login complete`,
            `<p>You can return to OpenClaude now.</p>`,
          ))
        })
      }

      return tokens
    } catch (error) {
      if (listener.hasPendingResponse()) {
        const msg = error instanceof Error ? error.message : String(error)
        listener.handleErrorRedirect(res => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderPage(
            `${config.displayName} Login Failed`,
            `${config.displayName} login failed`,
            `<p>${escapeHtml(msg)}</p><p>Close this window and try again in OpenClaude.</p>`,
            '#991b1b',
          ))
        })
      }
      throw error
    } finally {
      listener.close()
      this.authCodeListener = null
    }
  }

  private async exchangeCode(options: {
    config: OAuthConfig
    authorizationCode: string
    codeVerifier: string
    redirectUri: string
    signal?: AbortSignal
  }): Promise<OAuthTokensGeneric> {
    const { config, authorizationCode, codeVerifier, redirectUri, signal } = options

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    })
    if (config.clientSecret) {
      body.set('client_secret', config.clientSecret)
    }

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        text.trim()
          ? `${config.displayName} OAuth token exchange failed (${response.status}): ${text.trim()}`
          : `${config.displayName} OAuth token exchange failed with status ${response.status}.`,
      )
    }

    const payload = (await response.json()) as Record<string, unknown>
    const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : ''
    if (!accessToken) {
      throw new Error(`${config.displayName} OAuth completed but response missing access_token.`)
    }

    const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token.trim() : undefined
    const idToken = typeof payload.id_token === 'string' ? payload.id_token.trim() : undefined
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : undefined

    return {
      accessToken,
      refreshToken: refreshToken || undefined,
      idToken: idToken || undefined,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    }
  }

  cleanup(): void {
    this.tokenExchangeAbortController?.abort()
    this.tokenExchangeAbortController = null
    this.authCodeListener?.close()
    this.authCodeListener = null
  }
}

// ─── Device Authorization Grant (RFC 8628) ─────────────────────────────────

export async function startDeviceFlow(
  config: OAuthConfig,
): Promise<DeviceAuthorizationResponse> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scopes.join(' '),
  })
  if (config.clientSecret) body.set('client_secret', config.clientSecret)

  const response = await fetch(config.authorizationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `${config.displayName} device authorization failed (${response.status}): ${text.trim() || 'unknown error'}`,
    )
  }

  const data = (await response.json()) as Record<string, unknown>
  const deviceCode = typeof data.device_code === 'string' ? data.device_code : ''
  const userCode = typeof data.user_code === 'string' ? data.user_code : ''
  const verificationUri = typeof data.verification_uri === 'string' ? data.verification_uri : ''

  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(`${config.displayName} device authorization returned malformed response.`)
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 900,
    interval: typeof data.interval === 'number' ? data.interval : 5,
  }
}

export async function pollDeviceToken(
  config: OAuthConfig,
  deviceCode: string,
  intervalSeconds: number,
  signal?: AbortSignal,
): Promise<OAuthTokensGeneric> {
  const timeoutMs = config.timeoutMs
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new Error('Device flow cancelled.')

    await new Promise(r => setTimeout(r, intervalSeconds * 1000))
    if (signal?.aborted) throw new Error('Device flow cancelled.')

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: config.clientId,
      device_code: deviceCode,
    })
    if (config.clientSecret) body.set('client_secret', config.clientSecret)

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    })

    const data = (await response.json()) as Record<string, unknown>

    if (!response.ok || data.error) {
      const err = String(data.error ?? '')
      if (err === 'authorization_pending') continue
      if (err === 'slow_down') {
        intervalSeconds = typeof data.interval === 'number' ? data.interval : intervalSeconds + 5
        continue
      }
      if (err === 'expired_token') throw new Error('Device code expired. Start the login flow again.')
      if (err === 'access_denied') throw new Error('Authorization was denied or cancelled.')
      throw new Error(`${config.displayName} device token error: ${err || response.status}`)
    }

    const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : ''
    if (!accessToken) throw new Error(`${config.displayName} device token response missing access_token.`)

    return {
      accessToken,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
      expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
    }
  }

  throw new Error(`${config.displayName} device authorization timed out.`)
}
