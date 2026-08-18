import { $ } from "bun"

await $`bun ./scripts/generate-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`
