#!/usr/bin/env bun
import { $ } from "bun"
import { resolveOpencodeRoot } from "./embedded-server-path"

const opencodeRoot = resolveOpencodeRoot(import.meta.dir)

await $`bun install --cwd ${opencodeRoot} --os="*" --cpu="*" --frozen-lockfile`
await $`bun run --cwd ${opencodeRoot} build:embedded-server`
