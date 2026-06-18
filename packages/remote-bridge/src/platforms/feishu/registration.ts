// Feishu "personal agent" connect via the OAuth device-authorization flow.
// The user scans a QR with the Feishu / Lark app; Feishu mints a personal-agent
// app and hands its App ID + App Secret straight back to this client — no manual
// app creation, no public webhook, no relay. This is the same registration
// endpoint the official Lark CLI / @larksuiteoapi SDK drive: `begin` returns a
// launcher QR + device_code, then `poll` returns the credentials once approved.
//
// Pairing primitive only (it mints credentials); the live connection is the
// Feishu `Platform` adapter — mirroring how Telegram splits `captureFirstSender`
// (pairing) from `TelegramPlatform` (the running bridge).

const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn"
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com"
const REGISTRATION_PATH = "/oauth/v1/app/registration"
const REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_INTERVAL_S = 5
const DEFAULT_EXPIRES_S = 3600

export type FeishuDomain = "feishu" | "lark"

export interface FeishuRegistrationStart {
  /** Launcher URL to render as a QR; the user scans it with Feishu / Lark. */
  verificationUri: string
  /** Short human-readable code shown under the QR, for the manual-entry fallback. */
  userCode: string
  /** Opaque handle passed back to `pollFeishuRegistration`. */
  deviceCode: string
  /** Poll cadence the server asks for. */
  intervalMs: number
  /** How long the device code stays valid. */
  expiresInMs: number
  /** Where polling begins; switches to "lark" if the scanning user is a Lark tenant. */
  domain: FeishuDomain
}

export interface FeishuCredentials {
  appId: string
  appSecret: string
  domain: FeishuDomain
}

export type FeishuRegistrationPoll =
  | { status: "pending"; domain: FeishuDomain }
  | ({ status: "done" } & FeishuCredentials)
  | { status: "error"; message: string }

/** A device-flow registration call failed before any credential could be minted. */
export class FeishuRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FeishuRegistrationError"
  }
}

interface FormResult {
  ok: boolean
  status: number
  data: Record<string, unknown>
}

/** Transport seam: POSTs a urlencoded form, returns parsed JSON. Swapped in tests. */
export type FormPoster = (url: string, form: Record<string, string>) => Promise<FormResult>

const defaultPost: FormPoster = async (url, form) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  let data: Record<string, unknown> = {}
  try {
    data = (await res.json()) as Record<string, unknown>
  } catch {
    // Non-JSON body (e.g. a gateway error page) leaves data empty; status carries the failure.
  }
  return { ok: res.ok, status: res.status, data }
}

function accountsBaseUrl(domain: FeishuDomain): string {
  return domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL
}

function str(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  return typeof value === "string" ? value.trim() : ""
}

function intOr(value: unknown, fallbackSeconds: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackSeconds
}

/**
 * Begin device-flow registration. Always starts on Feishu — even for Lark
 * tenants — because the launcher QR is minted on accounts.feishu.cn (an
 * open.feishu.cn link); polling then discovers a Lark tenant and switches.
 * Returns the QR target and the device_code to poll.
 */
export async function startFeishuRegistration(opts: { post?: FormPoster } = {}): Promise<FeishuRegistrationStart> {
  const post = opts.post ?? defaultPost
  let result: FormResult
  try {
    result = await post(FEISHU_ACCOUNTS_URL + REGISTRATION_PATH, {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      // Ask for tenant_brand so polling can detect a Lark tenant and switch domains.
      request_user_info: "open_id tenant_brand",
    })
  } catch (err) {
    throw new FeishuRegistrationError(`could not reach Feishu: ${message(err)}`)
  }
  const { data } = result
  if (!result.ok) {
    throw new FeishuRegistrationError(str(data, "error_description") || str(data, "message") || `HTTP ${result.status}`)
  }
  const verificationUri = str(data, "verification_uri_complete") || str(data, "verification_uri")
  const deviceCode = str(data, "device_code")
  if (verificationUri === "" || deviceCode === "") {
    throw new FeishuRegistrationError(
      str(data, "error_description") || "Feishu returned an incomplete registration response",
    )
  }
  return {
    verificationUri,
    userCode: str(data, "user_code"),
    deviceCode,
    intervalMs: intOr(data.interval, DEFAULT_INTERVAL_S) * 1000,
    expiresInMs: intOr(data.expires_in ?? data.expire_in, DEFAULT_EXPIRES_S) * 1000,
    domain: "feishu",
  }
}

/**
 * Poll once for the credentials. Returns `pending` until the user approves. When
 * a Lark tenant is detected (tenant_brand=lark with no secret yet) it re-polls on
 * accounts.larksuite.com within the same call and reports the switched domain, so
 * the caller threads it back on the next poll.
 */
export async function pollFeishuRegistration(
  deviceCode: string,
  domain: FeishuDomain,
  opts: { post?: FormPoster } = {},
): Promise<FeishuRegistrationPoll> {
  const post = opts.post ?? defaultPost
  let active = domain
  let result: FormResult
  try {
    result = await pollOnce(post, deviceCode, active)
    // A Lark tenant's Feishu poll returns tenant_brand=lark and no secret; the
    // credentials are issued by accounts.larksuite.com. Switch and re-poll.
    if (active === "feishu" && isLarkTenant(result.data) && str(result.data, "client_secret") === "") {
      active = "lark"
      result = await pollOnce(post, deviceCode, active)
    }
  } catch (err) {
    return { status: "error", message: message(err) }
  }
  const { data } = result
  const error = str(data, "error")
  if (error === "authorization_pending" || error === "slow_down") return { status: "pending", domain: active }
  if (error !== "") return { status: "error", message: str(data, "error_description") || error }
  if (!result.ok) {
    return { status: "error", message: str(data, "error_description") || str(data, "message") || `HTTP ${result.status}` }
  }
  const appId = str(data, "client_id")
  const appSecret = str(data, "client_secret")
  if (appId !== "" && appSecret !== "") return { status: "done", appId, appSecret, domain: active }
  return { status: "pending", domain: active }
}

function pollOnce(post: FormPoster, deviceCode: string, domain: FeishuDomain): Promise<FormResult> {
  return post(accountsBaseUrl(domain) + REGISTRATION_PATH, { action: "poll", device_code: deviceCode })
}

function isLarkTenant(data: Record<string, unknown>): boolean {
  const info = data.user_info
  if (!info || typeof info !== "object") return false
  return str(info as Record<string, unknown>, "tenant_brand") === "lark"
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
