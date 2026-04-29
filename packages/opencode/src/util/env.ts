const INTERNAL_SERVER_AUTH_ENV = new Set(["opencode_server_password", "opencode_server_username"])

export function withoutInternalServerAuthEnv<T extends Record<string, string | undefined>>(env: T): T {
  const sanitized = { ...env }
  for (const key of Object.keys(sanitized)) {
    if (INTERNAL_SERVER_AUTH_ENV.has(key.toLowerCase())) delete sanitized[key]
  }
  return sanitized
}

export function envValueCaseInsensitive(env: Record<string, string | undefined> | undefined, name: string) {
  const normalized = name.toLowerCase()
  return Object.entries(env ?? {}).find(([key]) => key.toLowerCase() === normalized)?.[1]
}
