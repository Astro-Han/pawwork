const INTERNAL_SERVER_AUTH_ENV = new Set(["opencode_server_password", "opencode_server_username"])

export function withoutInternalServerAuthEnv<T extends Record<string, string | undefined>>(env: T): T {
  for (const key of Object.keys(env)) {
    if (INTERNAL_SERVER_AUTH_ENV.has(key.toLowerCase())) delete env[key]
  }
  return env
}
