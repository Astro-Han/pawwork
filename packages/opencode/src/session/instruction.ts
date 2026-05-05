import path from "path"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config"
import { InstanceState } from "@/effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { PawWorkHome } from "@opencode-ai/core/pawwork-home"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Log } from "@opencode-ai/core/util/log"
import { Runtime } from "@opencode-ai/core/runtime"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

const log = Log.create({ service: "instruction" })

// PawWork keeps project-level CLAUDE.md as compatibility (issue #230, acceptance #6),
// even if a parent process inherits OPENCODE_DISABLE_CLAUDE_CODE_PROMPT. The flag only
// suppresses Claude Code interop in plain opencode CLI mode. Exported so the gate can
// be unit tested without mutating module-scope flags.
export function projectFiles(deps: { isPawWork: boolean; disableClaudeCodePrompt: boolean }): string[] {
  return [
    "AGENTS.md",
    ...(deps.isPawWork || !deps.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
    "CONTEXT.md", // deprecated
  ]
}

function FILES() {
  return projectFiles({
    isPawWork: Runtime.isPawWork(),
    disableClaudeCodePrompt: Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT,
  })
}

function configDir() {
  if (Runtime.isPawWork()) return PawWorkHome.primary()
  return Flag.OPENCODE_CONFIG_DIR
}

function globalInstructionFiles() {
  if (Runtime.isPawWork()) return PawWorkHome.instructionFiles()
  const files = []
  const dir = configDir()
  if (dir) {
    files.push(path.join(dir, "AGENTS.md"))
  }
  files.push(path.join(Global.Path.config, "AGENTS.md"))
  // PawWork product baseline never falls back to global ~/.claude/CLAUDE.md (issue #230,
  // acceptance #5). The flag still gates the fallback for plain opencode CLI users so
  // their Claude Code interop is unchanged. Read Global.Path.home so OPENCODE_TEST_HOME
  // can stub the home directory deterministically; os.homedir() is locked at process start.
  if (!Runtime.isPawWork() && !Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(Global.Path.home, ".claude", "CLAUDE.md"))
  }
  return files
}

function extract(messages: MessageV2.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

export type InstructionSource =
  | { status: "loaded"; path: string }
  | { status: "considered"; path: string; reason: string }
  | { status: "ignored"; path: string; reason: string }

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, AppFileSystem.Error>
  readonly system: () => Effect.Effect<string[], AppFileSystem.Error>
  readonly sources: () => Effect.Effect<InstructionSource[], AppFileSystem.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, AppFileSystem.Error>
  readonly resolve: (
    messages: MessageV2.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], AppFileSystem.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

export const layer: Layer.Layer<Service, never, AppFileSystem.Service | Config.Service | HttpClient.HttpClient> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const cfg = yield* Config.Service
      const fs = yield* AppFileSystem.Service
      const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))

      const state = yield* InstanceState.make(
        Effect.fn("Instruction.state")(() =>
          Effect.succeed({
            // Track which instruction files have already been attached for a given assistant message.
            claims: new Map<MessageID, Set<string>>(),
          }),
        ),
      )

      const relative = Effect.fnUntraced(function* (instruction: string) {
        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          return yield* fs
            .globUp(instruction, Instance.directory, Instance.worktree)
            .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        }
        const dir = configDir()
        if (!dir) {
          const env = Runtime.isPawWork() ? "PAWWORK_CONFIG_DIR" : "OPENCODE_CONFIG_DIR"
          log.warn(
            `Skipping relative instruction "${instruction}" - no ${env} set while project config is disabled`,
          )
          return []
        }
        return yield* fs
          .globUp(instruction, dir, dir)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      })

      const read = Effect.fnUntraced(function* (filepath: string) {
        return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
      })

      const fetch = Effect.fnUntraced(function* (url: string) {
        const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
          Effect.timeout(5000),
          Effect.catch(() => Effect.succeed(null)),
        )
        if (!res) return ""
        const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
        return new TextDecoder().decode(body)
      })

      const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
        const s = yield* InstanceState.get(state)
        s.claims.delete(messageID)
      })

      const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
        const config = yield* cfg.get()
        const paths = new Set<string>()

        // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of FILES()) {
            const matches = yield* fs.findUp(file, Instance.directory, Instance.worktree)
            if (matches.length > 0) {
              matches.forEach((item) => paths.add(path.resolve(item)))
              break
            }
          }
        }

        for (const file of globalInstructionFiles()) {
          if (yield* fs.existsSafe(file)) {
            paths.add(path.resolve(file))
            break
          }
        }

        if (config.instructions) {
          for (const raw of config.instructions) {
            if (raw.startsWith("https://") || raw.startsWith("http://")) continue
            // Route through Global.Path.home so systemPaths() and sources() agree on
            // ~/ resolution; otherwise diagnostics could point at one path while the
            // prompt reads from another.
            const instruction = raw.startsWith("~/") ? path.join(Global.Path.home, raw.slice(2)) : raw
            const matches = yield* (
              path.isAbsolute(instruction)
                ? fs.glob(path.basename(instruction), {
                    cwd: path.dirname(instruction),
                    absolute: true,
                    include: "file",
                  })
                : relative(instruction)
            ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
            matches.forEach((item) => paths.add(path.resolve(item)))
          }
        }

        return paths
      })

      const system = Effect.fn("Instruction.system")(function* () {
        const config = yield* cfg.get()
        const paths = yield* systemPaths()
        const urls = (config.instructions ?? []).filter(
          (item) => item.startsWith("https://") || item.startsWith("http://"),
        )

        const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
        const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

        return [
          ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
          ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
        ]
      })

      const sources = Effect.fn("Instruction.sources")(function* () {
        const result: InstructionSource[] = []
        const loadedPaths = new Set<string>()

        // Mark a file as loaded only after read() returns non-empty content; system()
        // already drops empty/unreadable files so a "loaded" entry that the prompt
        // doesn't see would mislead diagnostics.
        const recordFileEntry = Effect.fnUntraced(function* (resolved: string) {
          const content = yield* read(resolved)
          if (content) {
            result.push({ status: "loaded", path: resolved })
            loadedPaths.add(resolved)
            return true as const
          }
          result.push({ status: "considered", path: resolved, reason: "file is empty or unreadable" })
          return false as const
        })

        // Project-level walk: emit the full priority chain, not just the winner. First
        // file whose content reads back non-empty is loaded; later existing matches are
        // considered with a priority-skipped reason. Absent files are not reported here
        // because FILES holds basenames, not paths — the directory walk is the search.
        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          let projectLoaded = false
          for (const file of FILES()) {
            const matches = yield* fs.findUp(file, Instance.directory, Instance.worktree)
            if (matches.length === 0) continue
            for (const match of matches) {
              const resolved = path.resolve(match)
              if (loadedPaths.has(resolved)) continue
              if (!projectLoaded) {
                const ok = yield* recordFileEntry(resolved)
                if (ok) projectLoaded = true
              } else {
                result.push({
                  status: "considered",
                  path: resolved,
                  reason: "skipped because a higher-priority project instruction file was loaded",
                })
              }
            }
          }
        }

        // Global instruction file chain: report the full priority chain so debug output
        // can show why a candidate was skipped (priority) or absent.
        let globalLoaded = false
        for (const file of globalInstructionFiles()) {
          const resolved = path.resolve(file)
          if (loadedPaths.has(resolved)) continue
          const exists = yield* fs.existsSafe(file)
          if (!exists) {
            result.push({ status: "considered", path: resolved, reason: "absent" })
            continue
          }
          if (globalLoaded) {
            result.push({
              status: "considered",
              path: resolved,
              reason: "skipped because a higher-priority global instruction file was loaded",
            })
            continue
          }
          const ok = yield* recordFileEntry(resolved)
          if (ok) globalLoaded = true
        }

        // Local file entries from config.instructions: glob-resolve them the same way
        // systemPaths() does so the diagnostic includes file-based config contributions,
        // not just URLs. Empty/unreadable matches are downgraded to considered so
        // diagnostics agree with what system() actually loads.
        const config = yield* cfg.get()
        const localInstructions = (config.instructions ?? []).filter(
          (item) => !item.startsWith("https://") && !item.startsWith("http://"),
        )
        for (const raw of localInstructions) {
          const instruction = raw.startsWith("~/") ? path.join(Global.Path.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          if (matches.length === 0) {
            result.push({
              status: "considered",
              path: raw,
              reason: "config.instructions entry resolved to no files",
            })
            continue
          }
          for (const match of matches) {
            const resolved = path.resolve(match)
            if (loadedPaths.has(resolved)) continue
            yield* recordFileEntry(resolved)
          }
        }

        // Remote instruction URLs from config.instructions: fetch concurrently to match
        // system()'s 4-way concurrency, so a handful of dead URLs don't stack 5s timeouts
        // and make sources() noticeably slower than the prompt build.
        const urls = (config.instructions ?? []).filter(
          (item) => item.startsWith("https://") || item.startsWith("http://"),
        )
        const bodies = yield* Effect.forEach(urls, fetch, { concurrency: 4 })
        for (const [index, url] of urls.entries()) {
          const body = bodies[index]
          if (body) {
            result.push({ status: "loaded", path: url })
          } else {
            result.push({ status: "considered", path: url, reason: "fetch failed or returned empty body" })
          }
        }

        // Explicitly ignored ~/.claude/CLAUDE.md: show reason so users understand why
        // an existing file is not contributing. Covers both PawWork mode (issue #230,
        // acceptance #5) and the legacy OPENCODE_DISABLE_CLAUDE_CODE_PROMPT opt-out.
        const claudeFallback = path.resolve(path.join(Global.Path.home, ".claude", "CLAUDE.md"))
        const ignoreReason = Runtime.isPawWork()
          ? "PawWork product baseline disables global Claude Code fallback (issue #230)"
          : Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
            ? "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT environment variable is set"
            : null
        if (ignoreReason && !loadedPaths.has(claudeFallback)) {
          if (yield* fs.existsSafe(claudeFallback)) {
            result.push({ status: "ignored", path: claudeFallback, reason: ignoreReason })
          }
        }

        return result
      })

      const find = Effect.fn("Instruction.find")(function* (dir: string) {
        for (const file of FILES()) {
          const filepath = path.resolve(path.join(dir, file))
          if (yield* fs.existsSafe(filepath)) return filepath
        }
      })

      const resolve = Effect.fn("Instruction.resolve")(function* (
        messages: MessageV2.WithParts[],
        filepath: string,
        messageID: MessageID,
      ) {
        const sys = yield* systemPaths()
        const already = extract(messages)
        const results: { filepath: string; content: string }[] = []
        const s = yield* InstanceState.get(state)

        const target = path.resolve(filepath)
        const root = path.resolve(Instance.directory)
        let current = path.dirname(target)

        // Walk upward from the file being read and attach nearby instruction files once per message.
        while (current.startsWith(root) && current !== root) {
          const found = yield* find(current)
          if (!found || found === target || sys.has(found) || already.has(found)) {
            current = path.dirname(current)
            continue
          }

          let set = s.claims.get(messageID)
          if (!set) {
            set = new Set()
            s.claims.set(messageID, set)
          }
          if (set.has(found)) {
            current = path.dirname(current)
            continue
          }

          set.add(found)
          const content = yield* read(found)
          if (content) {
            results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
          }

          current = path.dirname(current)
        }

        return results
      })

      return Service.of({ clear, systemPaths, system, sources, find, resolve })
    }),
  )

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export function loaded(messages: MessageV2.WithParts[]) {
  return extract(messages)
}

export * as Instruction from "./instruction"
