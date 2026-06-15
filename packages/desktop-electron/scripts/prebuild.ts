#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/generate-icons.ts ${channel}`
await $`bun ./scripts/build-remote-bridge.ts`
await $`bun ./scripts/prepare-embedded-server.ts`
