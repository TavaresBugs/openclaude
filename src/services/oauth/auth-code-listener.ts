import type { IncomingMessage, ServerResponse } from 'http'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { logEvent } from 'src/services/analytics/index.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { logError } from '../../utils/log.js'
import { shouldUseClaudeAIAuth } from './client.js'

/**
 * Temporary localhost HTTP server that listens for OAuth authorization code redirects.
 *
 * When the user authorizes in their browser, the OAuth provider redirects to:
 * http://localhost:[port]/callback?code=AUTH_CODE&state=STATE
 *
 * This server captures that redirect and extracts the auth code.
 * Note: This is NOT an OAuth server - it's just a redirect capture mechanism.
 */
export class AuthCodeListener {
  private localServer: Server
  private closeTimer: NodeJS.Timeout | null = null
  private port: number = 0
  private promiseResolver: ((authorizationCode: string) => void) | null = null
  private promiseRejecter: ((error: Error) => void) | null = null
  private expectedState: string | null = null // State parameter for CSRF protection
  private pendingResponse: ServerResponse | null = null // Response object for final redirect
  private callbackPath: string // Configurable callback path

  constructor(callbackPath: string = '/callback') {
    this.callbackPath = callbackPath
    this.localServer = createServer(this.handleRedirect.bind(this))
  }

  /**
   * Starts listening on an OS-assigned port and returns the port number.
   * This avoids race conditions by keeping the server open until it's used.
   * @param port Optional specific port to use. If not provided, uses OS-assigned port.
   */
  async start(port?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.localServer.once('error', err => {
        reject(
          new Error(`Failed to start OAuth callback server: ${err.message}`),
        )
      })

      // Listen on localhost only. The request handler is installed before
      // listen() so early browser requests never hang without a response.
      this.localServer.listen(port ?? 0, 'localhost', () => {
        this.localServer.unref()
        const address = this.localServer.address() as AddressInfo
        this.port = address.port
        resolve(this.port)
      })
    })
  }

  getPort(): number {
    return this.port
  }

  hasPendingResponse(): boolean {
    return this.pendingResponse !== null
  }

  /**
   * Keep the callback listener from lingering forever if the UI disappears or
   * cancellation input is swallowed by the terminal.
   */
  closeAfter(ms: number): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
    }
    this.closeTimer = setTimeout(() => {
      this.cancelPendingAuthorization()
    }, ms)
    this.closeTimer.unref()
  }

  async waitForAuthorization(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.promiseResolver = resolve
      this.promiseRejecter = reject
      this.expectedState = state
      this.startLocalListener(onReady)
    })
  }

  private respondToPendingRequest(options: {
    handler: (res: ServerResponse) => void
    analyticsEvent:
      | 'tengu_oauth_automatic_redirect'
      | 'tengu_oauth_automatic_redirect_error'
    analyticsMetadata?: Record<string, boolean>
  }): void {
    if (!this.pendingResponse) return

    const response = this.pendingResponse
    try {
      options.handler(response)

      if (!response.writableEnded && !response.destroyed) {
        response.end()
      }

      logEvent(options.analyticsEvent, options.analyticsMetadata ?? {})
    } catch (error) {
      logError(error)

      if (!response.headersSent && !response.destroyed) {
        response.writeHead(500, {
          'Content-Type': 'text/plain; charset=utf-8',
        })
      }
      if (!response.writableEnded && !response.destroyed) {
        response.end('Authentication redirect failed')
      }
    } finally {
      if (this.pendingResponse === response) {
        this.pendingResponse = null
      }
    }
  }

  /**
   * Completes the OAuth flow by redirecting the user's browser to a success page.
   * Different success pages are shown based on the granted scopes.
   * @param scopes The OAuth scopes that were granted
   * @param customHandler Optional custom handler to serve response instead of redirecting
   */
  handleSuccessRedirect(
    scopes: string[],
    customHandler?: (res: ServerResponse, scopes: string[]) => void,
  ): void {
    if (!this.pendingResponse) return

    // If custom handler provided, use it instead of default redirect
    if (customHandler) {
      this.respondToPendingRequest({
        handler: res => {
          customHandler(res, scopes)
        },
        analyticsEvent: 'tengu_oauth_automatic_redirect',
        analyticsMetadata: { custom_handler: true },
      })
      return
    }

    // Default behavior: Choose success page based on granted permissions
    const successUrl = shouldUseClaudeAIAuth(scopes)
      ? getOauthConfig().CLAUDEAI_SUCCESS_URL
      : getOauthConfig().CONSOLE_SUCCESS_URL

    // Send browser to success page
    this.respondToPendingRequest({
      handler: res => {
        res.writeHead(302, { Location: successUrl })
        res.end()
      },
      analyticsEvent: 'tengu_oauth_automatic_redirect',
    })
  }

  /**
   * Handles error case by sending a redirect to the appropriate success page with an error indicator,
   * ensuring the browser flow is completed properly.
   */
  handleErrorRedirect(customHandler?: (res: ServerResponse) => void): void {
    if (!this.pendingResponse) return

    if (customHandler) {
      this.respondToPendingRequest({
        handler: customHandler,
        analyticsEvent: 'tengu_oauth_automatic_redirect_error',
        analyticsMetadata: { custom_handler: true },
      })
      return
    }

    // TODO: swap to a different url once we have an error page
    const errorUrl = getOauthConfig().CLAUDEAI_SUCCESS_URL

    this.respondToPendingRequest({
      handler: res => {
        res.writeHead(302, { Location: errorUrl })
        res.end()
      },
      analyticsEvent: 'tengu_oauth_automatic_redirect_error',
    })
  }

  cancelPendingAuthorization(
    error: Error = new Error('OAuth authorization was cancelled.'),
  ): void {
    this.reject(error)
    this.close()
  }

  private startLocalListener(onReady: () => Promise<void>): void {
    // Server is already listening with its request handler installed, so we can call onReady immediately.
    void onReady()
  }

  private handleRedirect(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(
      req.url || '',
      `http://${req.headers.host || 'localhost'}`,
    )

    if (parsedUrl.pathname !== this.callbackPath) {
      res.writeHead(404)
      res.end()
      return
    }

    const oauthError = parsedUrl.searchParams.get('error') ?? undefined
    if (oauthError) {
      const description = parsedUrl.searchParams.get('error_description') ?? undefined
      const requestId = parsedUrl.searchParams.get('request_id') ?? undefined
      const parts = [description ?? `Authentication error: ${oauthError}`]
      if (requestId) parts.push(`Request ID: ${requestId}`)
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Authentication failed')
      this.reject(new Error(parts.join(' — ')))
      return
    }

    const authCode = parsedUrl.searchParams.get('code') ?? undefined
    const state = parsedUrl.searchParams.get('state') ?? undefined

    this.validateAndRespond(authCode, state, res)
  }

  private validateAndRespond(
    authCode: string | undefined,
    state: string | undefined,
    res: ServerResponse,
  ): void {
    if (!authCode) {
      res.writeHead(400)
      res.end('Authorization code not found')
      this.reject(new Error('No authorization code received'))
      return
    }

    if (state !== this.expectedState) {
      res.writeHead(400)
      res.end('Invalid state parameter')
      this.reject(new Error('Invalid state parameter'))
      return
    }

    // Store the response for later redirect
    this.pendingResponse = res

    this.resolve(authCode)
  }

  private handleError(err: Error): void {
    logError(err)
    this.cancelPendingAuthorization(err)
  }

  private resolve(authorizationCode: string): void {
    if (this.promiseResolver) {
      this.promiseResolver(authorizationCode)
      this.promiseResolver = null
      this.promiseRejecter = null
      this.expectedState = null
    }
  }

  private reject(error: Error): void {
    if (this.promiseRejecter) {
      this.promiseRejecter(error)
      this.promiseResolver = null
      this.promiseRejecter = null
      this.expectedState = null
    }
  }

  close(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }

    // If we have a pending response, send a redirect before closing
    if (this.pendingResponse) {
      this.handleErrorRedirect()
    }

    if (this.localServer) {
      this.localServer.closeAllConnections()
      this.localServer.close()
    }

    this.pendingResponse = null
    this.expectedState = null
    this.port = 0
  }
}
