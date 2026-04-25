// ─── Claude internal OAuth types ────────────────────────────────────────────

export type SubscriptionType =
  | 'claude_pro'
  | 'claude_team'
  | 'claude_enterprise'
  | 'free'
  | string

export type RateLimitTier = 'default' | 'pro' | 'team' | 'enterprise' | string

export type BillingType = 'claude_ai' | 'api' | string

export type OAuthProfileResponse = {
  id?: string
  email?: string
  name?: string
  [key: string]: unknown
}

export type UserRolesResponse = {
  roles?: string[]
  [key: string]: unknown
}

export type OAuthTokenExchangeResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
  token_type?: string
  account?: { uuid: string; email_address: string }
  organization?: { uuid: string }
}

export type OAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  billingType?: BillingType | null
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}

// ─── Referral types ──────────────────────────────────────────────────────────

export type ReferralCampaign = 'claude_code_guest_pass' | string

export type ReferrerRewardInfo = {
  rewardType?: string
  amount?: number
  currency?: string
  [key: string]: unknown
}

export type ReferralRedemptionsResponse = {
  redemptions?: unknown[]
  [key: string]: unknown
}

export type ReferralEligibilityResponse = {
  eligible: boolean
  campaign?: ReferralCampaign
  referrerReward?: ReferrerRewardInfo
  [key: string]: unknown
}

// ─── Provider OAuth config (our addition) ───────────────────────────────────

export type OAuthFlow = 'pkce' | 'device'

/**
 * Generic OAuth configuration for any provider.
 * PKCE flow: browser redirect to localhost callback.
 * Device flow: user enters a code at a URL (RFC 8628).
 */
export interface OAuthConfig {
  providerId: string
  displayName: string
  clientId: string
  clientSecret?: string
  authorizationUrl: string
  tokenUrl: string
  callbackPath: string
  callbackPort: number
  fallbackPorts: number[]
  timeoutMs: number
  scopes: string[]
  credentialsPath: string
  flow: OAuthFlow
  defaultBaseUrl: string
  apiKeyBaseUrl?: string
}

export interface OAuthTokensGeneric {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresAt?: number
}

export interface DeviceAuthorizationResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}
