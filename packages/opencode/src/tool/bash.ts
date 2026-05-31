import { Schema } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import nodefs from "node:fs/promises"
import * as Tool from "./tool"
import path from "path"
import crypto from "crypto"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util"
import { Instance, type InstanceContext } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language, type Node, type Tree } from "web-tree-sitter"

import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Shell } from "@/shell/shell"
import { Process } from "@/util/process"

import { BashArity } from "@/permission/arity"
import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { envValueCaseInsensitive, prependBundledTools, stripPathKeys, withoutInternalServerAuthEnv } from "@/util/env"
import { Global } from "@opencode-ai/core/global"
import { assertExternalDirectoryEffect, resolveExternalPathForPermission } from "./external-directory"
import { InstanceState } from "@/effect/instance-state"
import * as Bom from "@/util/bom"
import { TurnChange, type FileState } from "@/session/turn-change"
import { isLikelyWriteCommand } from "./bash-write-heuristic"
import { FileIgnore } from "@/file/ignore"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const TRACKED_OUTPUT_LIMIT = 20 * 1024 * 1024
const OFFICE_OUTPUT_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"])
const AUTO_DISCOVERY_BUDGET = {
  maxFiles: 500,
  maxDirs: 80,
  maxDepth: 3,
  maxMillis: 75,
  maxCaptures: 16,
}
const PS = new Set(["powershell", "pwsh"])
const CWD = new Set(["cd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

export const Parameters = Schema.Struct({
  command: Schema.String.annotate({ description: "The command to execute" }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in milliseconds" }),
  workdir: Schema.optional(Schema.String).annotate({
    description: `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
  }),
  expected_outputs: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description:
        "Optional absolute or workdir-relative file paths that this command is expected to create or modify. The runtime will verify these paths after execution and register any real file changes in turn-change.",
    }),
  ),
  description: Schema.String.annotate({
    description:
      "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
  }),
})

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

type OutputDiscovery = {
  paths: string[]
  overflowed: boolean
}

function isOfficeOutputPath(file: string) {
  return OFFICE_OUTPUT_EXTENSIONS.has(path.extname(file).toLowerCase())
}

function relativeDiscoveryPath(root: string, file: string) {
  return path.relative(root, file).replaceAll("\\", "/")
}

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*\[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean) {
  if (!ps) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

function textHash(content: string, bom?: boolean) {
  return (
    "sha256:" +
    crypto
      .createHash("sha256")
      .update(`${bom ? "bom:1" : "bom:0"}\0${content}`)
      .digest("hex")
  )
}

function binaryHash(buffer: Buffer) {
  return "sha256-bin:" + crypto.createHash("sha256").update(buffer).digest("hex")
}

function sameState(before: FileState, after: FileState) {
  if (!before.exists && !after.exists) return true
  return (
    before.exists === after.exists &&
    before.hash === after.hash &&
    before.bom === after.bom &&
    before.large === after.large &&
    before.binary === after.binary
  )
}

type TrackedOutputState = {
  state: FileState
  comparable: boolean
  kind: "missing" | "file" | "directory" | "error"
  errorCode?: string
}

const parse = Effect.fn("BashTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("BashTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: "bash",
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

function cmd(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && PS.has(name)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define(
  "bash",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const afs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const turnChange = yield* TurnChange.Service

    const cygpath = Effect.fn("BashTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolveExecutionPath = Effect.fn("BashTool.resolveExecutionPath")(function* (
      text: string,
      root: string,
      shell: string,
    ) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.isAbsolute(text) ? text : `${root.replace(/\/+$/, "")}/${text}`
    })

    const resolvePermissionTarget = Effect.fn("BashTool.resolvePermissionTarget")(function* (
      text: string,
      root: string,
      shell: string,
    ) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.windowsPath(text)
      }
      return path.isAbsolute(text) ? text : `${root.replace(/\/+$/, "")}/${text}`
    })

    const argPath = Effect.fn("BashTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePermissionTarget(next, cwd, shell)
    })

    const collect = Effect.fn("BashTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && FILES.has(cmd)) {
          for (const arg of pathArgs(command, ps)) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved) continue
            const permissionPath = resolveExternalPathForPermission(resolved, cwd)
            if (Instance.containsPath(permissionPath, instance)) continue
            const dir = (yield* afs.isDir(permissionPath)) ? permissionPath : path.dirname(permissionPath)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("BashTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      const extraEnv = extra.env as Record<string, string>
      // Read PATH case-insensitively: a shell plugin may emit "Path" on
      // Windows, and process.env preserves the OS casing during spread.
      // After the merge, strip every case-variant of PATH before writing
      // back a single canonical PATH so the spawned child does not receive
      // both `Path` and `PATH` (the latter would otherwise win and drop
      // the inherited system path).
      const currentPath =
        envValueCaseInsensitive(extraEnv, "PATH") ?? envValueCaseInsensitive(process.env, "PATH") ?? ""
      const env = withoutInternalServerAuthEnv({
        ...process.env,
        ...extraEnv,
        OFFICECLI_SKIP_UPDATE: "1",
      } as Record<string, string>)
      stripPathKeys(env)
      env.PATH = prependBundledTools(currentPath)
      return env
    })

    const discoverOfficeOutputs = Effect.fn("BashTool.discoverOfficeOutputs")((root: string) =>
      Effect.promise(async () => {
        const started = Date.now()
        const paths: string[] = []
        let files = 0
        let dirs = 0
        let overflowed = false

        const timeExceeded = () => Date.now() - started > AUTO_DISCOVERY_BUDGET.maxMillis
        const overflow = () => {
          overflowed = true
        }

        const scan = async (dir: string, depth: number): Promise<void> => {
          if (overflowed) return
          if (timeExceeded() || dirs >= AUTO_DISCOVERY_BUDGET.maxDirs) {
            overflow()
            return
          }
          dirs++

          let entries: Awaited<ReturnType<typeof nodefs.opendir>>
          try {
            entries = await nodefs.opendir(dir)
          } catch {
            return
          }

          for await (const entry of entries) {
            if (overflowed) return
            if (timeExceeded()) {
              overflow()
              return
            }
            const absolute = path.join(dir, entry.name)
            const relative = relativeDiscoveryPath(root, absolute)
            if (!relative || FileIgnore.match(relative)) continue

            if (entry.isDirectory()) {
              if (depth >= AUTO_DISCOVERY_BUDGET.maxDepth) continue
              await scan(absolute, depth + 1)
              continue
            }

            if (!entry.isFile()) continue
            if (files >= AUTO_DISCOVERY_BUDGET.maxFiles) {
              overflow()
              return
            }
            files++
            if (isOfficeOutputPath(entry.name)) {
              if (paths.length >= AUTO_DISCOVERY_BUDGET.maxCaptures) {
                overflow()
                return
              }
              paths.push(absolute)
            }
          }
        }

        await scan(root, 0)
        return {
          paths: Array.from(new Set(paths.map((item) => AppFileSystem.normalizePath(item)))).sort((a, b) =>
            a.localeCompare(b),
          ),
          overflowed,
        } satisfies OutputDiscovery
      }),
    )

    const readTrackedState = Effect.fn("BashTool.readTrackedState")((file: string) =>
      Effect.promise(async () => {
        try {
          const stat = await nodefs.stat(file)
          if (stat.isDirectory()) {
            return {
              state: { exists: true, restorable: false, hash: "directory", binary: true } satisfies FileState,
              comparable: true,
              kind: "directory",
            } satisfies TrackedOutputState
          }
          if (isOfficeOutputPath(file)) {
            if (stat.size > TRACKED_OUTPUT_LIMIT) {
              return {
                state: {
                  exists: true,
                  restorable: false,
                  hash: `large:${stat.size}:${stat.mtimeMs}`,
                  large: true,
                  binary: true,
                } satisfies FileState,
                comparable: true,
                kind: "file",
              } satisfies TrackedOutputState
            }
            const buffer = await nodefs.readFile(file)
            return {
              state: {
                exists: true,
                restorable: false,
                hash: binaryHash(buffer),
                binary: true,
              } satisfies FileState,
              comparable: true,
              kind: "file",
            } satisfies TrackedOutputState
          }
          if (stat.size > TRACKED_OUTPUT_LIMIT) {
            return {
              state: {
                exists: true,
                restorable: false,
                hash: `large:${stat.size}:${stat.mtimeMs}`,
                large: true,
              } satisfies FileState,
              comparable: true,
              kind: "file",
            } satisfies TrackedOutputState
          }
          const buffer = await nodefs.readFile(file)
          if (buffer.includes(0)) {
            return {
              state: {
                exists: true,
                restorable: false,
                hash: binaryHash(buffer),
                binary: true,
              } satisfies FileState,
              comparable: true,
              kind: "file",
            } satisfies TrackedOutputState
          }
          const current = Bom.split(buffer.toString("utf-8"))
          return {
            state: {
              exists: true,
              content: current.text,
              bom: current.bom,
              hash: textHash(current.text, current.bom),
            } satisfies FileState,
            comparable: true,
            kind: "file",
          } satisfies TrackedOutputState
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === "ENOENT")
            return {
              state: { exists: false } satisfies FileState,
              comparable: true,
              kind: "missing",
            } satisfies TrackedOutputState
          return {
            state: {
              exists: true,
              restorable: false,
              hash: `error:${code ?? "unknown"}`,
            } satisfies FileState,
            comparable: false,
            kind: "error",
            ...(code ? { errorCode: code } : {}),
          } satisfies TrackedOutputState
        }
      }).pipe(Effect.orDie),
    )

    const run = Effect.fn("BashTool.run")(function* (
      input: {
        shell: string
        name: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(cmd(input.shell, input.name, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          description: input.description,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                  description: input.description,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* Effect.promise(() =>
              Process.terminateTree({ pid: handle.pid, waitForExit: Effect.runPromise(handle.exitCode) }),
            ).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* Effect.promise(() =>
              Process.terminateTree({ pid: handle.pid, waitForExit: Effect.runPromise(handle.exitCode) }),
            ).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `bash tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"
      }
      if (sink) {
        const stream = sink
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              stream.end(() => resolve())
              stream.on("error", () => resolve())
            }),
        )
      }

      return {
        title: input.description,
        metadata: {
          output: last || preview(output),
          exit: code,
          description: input.description,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const directory = (yield* InstanceState.context).directory
        const shell = Shell.acceptable()
        const name = Shell.name(shell)
        const chain =
          name === "powershell"
            ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
            : "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."
        log.info("bash tool using shell", { shell })

        return {
          description: DESCRIPTION.replaceAll("${directory}", directory)
            .replaceAll("${tmp}", Global.Path.tmp)
            .replaceAll("${os}", process.platform)
            .replaceAll("${shell}", name)
            .replaceAll("${chaining}", chain)
            .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
            .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
          parameters: Parameters,
          execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instance = yield* InstanceState.context
              const directory = instance.directory
              const cwd = params.workdir ? yield* resolveExecutionPath(params.workdir, directory, shell) : directory
              const permissionCwdTarget = params.workdir
                ? yield* resolvePermissionTarget(params.workdir, directory, shell)
                : directory
              if (params.timeout !== undefined && params.timeout <= 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? DEFAULT_TIMEOUT
              const ps = PS.has(name)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree: Tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instance)
                  const permissionCwd = resolveExternalPathForPermission(permissionCwdTarget, directory)
                  if (!Instance.containsPath(permissionCwd, instance)) scan.dirs.add(permissionCwd)
                  yield* ask(ctx, scan)
                }),
              )

              const trackedOutputs = yield* Effect.forEach(
                params.expected_outputs ?? [],
                (rawPath) =>
                  Effect.gen(function* () {
                    const resolved = yield* resolveExecutionPath(rawPath, cwd, shell)
                    const normalized = AppFileSystem.normalizePath(resolved)
                    const filepath =
                      (yield* assertExternalDirectoryEffect(ctx, normalized, { kind: "file" })) ?? normalized
                    return {
                      normalized: AppFileSystem.normalizePath(filepath),
                      path: filepath,
                      before: yield* readTrackedState(filepath),
                    }
                  }),
                { concurrency: 4 },
              ).pipe(
                Effect.map((items) => {
                  const deduped = new Map<string, { path: string; before: TrackedOutputState }>()
                  for (const item of items) {
                    if (deduped.has(item.normalized)) continue
                    deduped.set(item.normalized, { path: item.path, before: item.before })
                  }
                  return Array.from(deduped.values())
                }),
              )
              const shouldAutoDiscoverOutputs =
                (params.expected_outputs ?? []).length === 0 && !!ctx.messageID && isLikelyWriteCommand(params.command)
              const autoDiscoveredBefore = shouldAutoDiscoverOutputs
                ? yield* Effect.gen(function* () {
                    const discovered = yield* discoverOfficeOutputs(cwd)
                    if (discovered.overflowed) return { outputs: [], overflowed: true }
                    const outputs = yield* Effect.forEach(
                      discovered.paths,
                      (filepath) =>
                        Effect.gen(function* () {
                          return {
                            path: filepath,
                            before: yield* readTrackedState(filepath),
                          }
                        }),
                      { concurrency: 4 },
                    )
                    return { outputs, overflowed: false }
                  })
                : undefined

              const result = yield* run(
                {
                  shell,
                  name,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  description: params.description,
                },
                ctx,
              )

              let outputsToRecord = trackedOutputs
              let autoDiscovered = false
              if (!trackedOutputs.length && shouldAutoDiscoverOutputs) {
                autoDiscovered = true
                let overflowed = autoDiscoveredBefore?.overflowed ?? false
                const deduped = new Map<string, { path: string; before: TrackedOutputState }>()
                if (!overflowed) {
                  for (const item of autoDiscoveredBefore?.outputs ?? []) {
                    const normalized = AppFileSystem.normalizePath(item.path)
                    if (deduped.has(normalized)) continue
                    deduped.set(normalized, item)
                  }
                  const discoveredAfter = yield* discoverOfficeOutputs(cwd)
                  overflowed = discoveredAfter.overflowed
                  if (!overflowed) {
                    for (const filepath of discoveredAfter.paths) {
                      const normalized = AppFileSystem.normalizePath(filepath)
                      if (deduped.has(normalized)) continue
                      deduped.set(normalized, {
                        path: filepath,
                        before: { state: { exists: false }, comparable: true, kind: "missing" },
                      })
                    }
                  }
                }

                if (overflowed) {
                  yield* turnChange.recordUncaptured({
                    sessionID: ctx.sessionID,
                    messageID: ctx.messageID,
                  })
                  return result
                }
                outputsToRecord = Array.from(deduped.values())
              }

              if (!outputsToRecord.length) {
                if (shouldAutoDiscoverOutputs) {
                  yield* turnChange.recordUncaptured({
                    sessionID: ctx.sessionID,
                    messageID: ctx.messageID,
                  })
                }
                return result
              }

              const artifacts = yield* Effect.forEach(
                outputsToRecord,
                (tracked) =>
                  Effect.gen(function* () {
                    const after = yield* readTrackedState(tracked.path)
                    const changed =
                      tracked.before.comparable && after.comparable && !sameState(tracked.before.state, after.state)
                    if (changed) {
                      yield* turnChange.recordWrite({
                        sessionID: ctx.sessionID,
                        messageID: ctx.messageID,
                        path: tracked.path,
                        before: tracked.before.state,
                        after: after.state,
                      })
                    }
                    return {
                      path: tracked.path,
                      exists: after.state.exists,
                      changed,
                      ...(after.kind === "directory" ? { directory: true } : {}),
                      ...(after.state.binary && after.kind !== "directory" ? { binary: true } : {}),
                      ...(after.state.large ? { large: true } : {}),
                      ...(!tracked.before.comparable || !after.comparable
                        ? {
                            comparable: false,
                            errorCode:
                              ("errorCode" in tracked.before ? tracked.before.errorCode : undefined) ??
                              ("errorCode" in after ? after.errorCode : undefined),
                          }
                        : {}),
                    }
                  }),
                { concurrency: 4 },
              )
              const visibleArtifacts = autoDiscovered ? artifacts.filter((item) => item.changed) : artifacts
              if (autoDiscovered && visibleArtifacts.length === 0) {
                yield* turnChange.recordUncaptured({
                  sessionID: ctx.sessionID,
                  messageID: ctx.messageID,
                })
                return result
              }
              if (autoDiscovered) {
                yield* turnChange.recordUncaptured({
                  sessionID: ctx.sessionID,
                  messageID: ctx.messageID,
                })
              }

              return {
                ...result,
                metadata: {
                  ...result.metadata,
                  artifacts: visibleArtifacts,
                },
              }
            }),
        }
      })
  }),
)
