export * as ServerAuth from "./auth"

import { Flag } from "@opencode-ai/core/flag/flag"
import { Option, Redacted } from "effect"

const PTY_CONNECT_PATH = /^\/pty\/[^/]+\/connect$/

export type Credentials = {
  password?: string
  username?: string
}

export type ConfigInfo = {
  password: Option.Option<string>
  username: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export function required(config: ConfigInfo) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: ConfigInfo) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}

export function unauthorizedResponse() {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="opencode"',
      "content-type": "text/plain; charset=UTF-8",
    },
  })
}

export function authorizeRequest(request: Request) {
  if (request.method === "OPTIONS") return

  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return

  const url = new URL(request.url)
  if (request.method === "GET" && PTY_CONNECT_PATH.test(url.pathname) && url.searchParams.get("ticket")) return

  const queryToken = url.searchParams.get("auth_token")
  const authHeader = request.headers.get("authorization")
  const header = queryToken ? "Basic " + queryToken : authHeader
  const match = header?.match(/^Basic\s+(.+)$/i)
  if (!match) return unauthorizedResponse()

  const decoded = Buffer.from(match[1], "base64").toString("utf8")
  const separator = decoded.indexOf(":")
  if (separator === -1) return unauthorizedResponse()

  const config = {
    password: Option.some(password),
    username: Flag.OPENCODE_SERVER_USERNAME ?? "opencode",
  }
  const credentials = {
    username: decoded.slice(0, separator),
    password: Redacted.make(decoded.slice(separator + 1)),
  }
  if (!authorized(credentials, config)) return unauthorizedResponse()
}
