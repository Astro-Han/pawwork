#!/usr/bin/env bun
import { $ } from "bun"
import { resolveOpencodeRoot } from "./embedded-server-path"

const opencodeRoot = resolveOpencodeRoot(import.meta.dir)

await $`bun run --cwd ${opencodeRoot} build:embedded-server`
