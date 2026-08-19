import type { PawWorkChannel } from "../src/main/app-identity.ts"

export type Channel = PawWorkChannel

export function resolveChannel(): Channel {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}
