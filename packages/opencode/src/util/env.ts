const INTERNAL_SERVER_AUTH_ENV = new Set(["opencode_server_password", "opencode_server_username"])

export function withoutInternalServerAuthEnv<T extends Record<string, string | undefined>>(env: T): T {
  for (const key of Object.keys(env)) {
    if (INTERNAL_SERVER_AUTH_ENV.has(key.toLowerCase())) delete env[key]
  }
  return env
}

export function envValueCaseInsensitive(env: Record<string, string | undefined> | undefined, name: string) {
  const normalized = name.toLowerCase()
  return Object.entries(env ?? {}).find(([key]) => key.toLowerCase() === normalized)?.[1]
}
