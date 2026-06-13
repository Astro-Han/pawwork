import type { Schema } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
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
import { Duration, Effect, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { envValueCaseInsensitive, prependBundledTools, stripPathKeys, withoutInternalServerAuthEnv } from "@/util/env"
import { Global } from "@opencode-ai/core/global"
import { assertExternalDirectoryEffect, resolveExternalPathForPermission } from "./external-directory"
import { InstanceState } from "@/effect/instance-state"
import { TurnChange } from "@/session/turn-change"
import { isLikelyWriteCommand } from "./shell-write-heuristic"
import { nonOfficeCliCommandText, officeCliTargets } from "./shell-office-artifacts"
import { discoverOfficeOutputs, readTrackedState } from "./shell-output-capture"
import { Parameters, render as renderDescription, type Limits } from "./shell/prompt"
import { ToolID as ShellToolID } from "./shell/id"
import { orchestrateArtifacts, type ArtifactDeps } from "./shell-artifact-orchestrator"
import { makeMetadataThrottle } from "./shell-metadata-throttle"

const MAX_METADATA_LENGTH = 30_000
// Coalesce streaming metadata pushes: emit the first chunk immediately, then at
// most once per interval or once accumulated input crosses the byte threshold.
const METADATA_FLUSH_INTERVAL_MS = 150
const METADATA_FLUSH_BYTES = 4 * 1024
// Cap how long we wait for the consumer to drain buffered output after the
// process exits/aborts/times out. On timeout we fall through to scope cleanup,
// which interrupts the consumer; the final tool-result metadata still carries
// the tail via completeToolCall, so this only bounds a pathological slow/never
// closing stream — it never blocks the normal path where the stream is already
// drained by the time the exit race resolves.
const CONSUMER_DRAIN_TIMEOUT = Duration.seconds(1)
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const PS = new Set(["powershell", "pwsh"])
// CWD commands are skipped from the generic bash-command prompt below (they are
// pure navigation builtins). Only put a command here when it is a real cwd
// builtin on every shell that reaches it — otherwise a same-named PATH
// executable would slip past the bash prompt (see pushd/chdir in FILES).
const CWD = new Set(["cd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  // pushd (POSIX) and chdir (cmd.exe) change the cwd into their target, so the
  // target argument must be scanned for external_directory the same way cd's is
  // (#1052: `pushd /external` previously read outside the project unprompted).
  // They stay OUT of CWD on purpose: pushd is not a builtin in sh/dash and chdir
  // is not a POSIX builtin at all, so they must still raise the generic bash
  // prompt — only the external-target scan is shared with cd.
  "pushd",
  "chdir",
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

export const log = Log.create({ service: "shell-tool" })

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

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (
  ctx: Tool.Context,
  scan: Scan,
  input: { command: string; description: string },
) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const displayDirectories = directories.map((dir) => (process.platform === "win32" ? dir.replaceAll("\\", "/") : dir))
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
        metadata: {
          command: input.command,
          description: input.description,
          directories: displayDirectories,
          patterns: globs,
        },
      })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
      description: input.description,
    },
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

// Public tool id stays "bash" indefinitely (kept in ShellToolID for the
// single source of truth — saved permissions, plugins, and config all
// reference this literal).
export const ShellTool = Tool.define(
  ShellToolID,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const afs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const turnChange = yield* TurnChange.Service

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolveExecutionPath = Effect.fn("ShellTool.resolveExecutionPath")(function* (
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

    const resolvePermissionTarget = Effect.fn("ShellTool.resolvePermissionTarget")(function* (
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

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePermissionTarget(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
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

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
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

    const run = Effect.fn("ShellTool.run")(function* (
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

          // Close the spill write stream on scope exit no matter how the scope
          // ends (exit, abort, timeout, interrupt, or defect). Registered before
          // the consumer fork so the consumer is interrupted first (finalizers
          // run LIFO), leaving no write racing the close.
          yield* Effect.addFinalizer(() =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  if (!sink) return resolve()
                  sink.end(() => resolve())
                  sink.on("error", () => resolve())
                }),
            ),
          )

          const throttle = yield* makeMetadataThrottle({
            intervalMillis: METADATA_FLUSH_INTERVAL_MS,
            byteThreshold: METADATA_FLUSH_BYTES,
            snapshot: () => last,
            emit: (output) => ctx.metadata({ metadata: { output, description: input.description } }),
          })

          const consumer = yield* Effect.forkScoped(
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
                return throttle.onChunk(size)
              }

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
                  Effect.andThen(throttle.flush("spill")),
                )
              }

              return throttle.onChunk(size)
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

          // Drain any chunks the consumer hasn't processed yet, then push the
          // final preview. Both happen inside the process scope so the throttle's
          // timer fiber is still alive and is interrupted on scope exit. The
          // timeout guards against a stream that never closes; ignore mirrors the
          // pre-existing fork-without-join behavior where consumer errors were
          // unobserved.
          yield* Fiber.join(consumer).pipe(Effect.timeout(CONSUMER_DRAIN_TIMEOUT), Effect.ignore)
          yield* throttle.flush("final")

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

    return Effect.fn("ShellTool.init")(function* () {
        const directory = (yield* InstanceState.context).directory
        const shell = Shell.acceptable()
        const name = Shell.name(shell)
        log.info("shell tool using shell", { shell })

        const limits: Limits = { maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES }
        const description = renderDescription({
          name,
          platform: process.platform,
          directory,
          tmp: Global.Path.tmp,
          limits,
          defaultTimeout: DEFAULT_TIMEOUT,
        })

        const deps: ArtifactDeps = {
          resolveExecutionPath,
          assertExternalDirectory: assertExternalDirectoryEffect,
          readTrackedState,
          discoverOfficeOutputs,
          officeCliTargets,
          nonOfficeCliCommandText,
          isLikelyWriteCommand,
          recordWrite: (input) => turnChange.recordWrite(input),
          recordUncaptured: (input) => turnChange.recordUncaptured(input),
        }

        return {
          description,
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
                  yield* ask(ctx, scan, params)
                }),
              )

              // shellEnv() must run AFTER the orchestrator's before-snapshots.
              // A `shell.env` plugin can create or modify files (config, sockets,
              // bundled-tool drops) as a side effect; running it before the
              // before-state read would fold that mutation into "before" and the
              // subsequent change would never surface as a turn-change record.
              return yield* orchestrateArtifacts(
                {
                  ctx,
                  cwd,
                  directory,
                  shell,
                  command: params.command,
                  expectedOutputs: params.expected_outputs ?? [],
                },
                () =>
                  Effect.gen(function* () {
                    const env = yield* shellEnv(ctx, cwd)
                    return yield* run(
                      {
                        shell,
                        name,
                        command: params.command,
                        cwd,
                        env,
                        timeout,
                        description: params.description,
                      },
                      ctx,
                    )
                  }),
                deps,
              )
            }),
        }
      })
  }),
)
