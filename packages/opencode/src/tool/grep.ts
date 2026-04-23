import z from "zod"
import { Effect, Fiber, Option } from "effect"
import * as Stream from "effect/Stream"
import * as Tool from "./tool"
import { InstanceState } from "@/effect"
import { AppFileSystem } from "@/filesystem"
import { Ripgrep } from "../file/ripgrep"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

import DESCRIPTION from "./grep.txt"
import path from "path"
import { assertExternalDirectoryEffect } from "./external-directory"

const MAX_LINE_LENGTH = 2000

function ripgrepEnv() {
  return {
    RIPGREP_CONFIG_PATH: undefined,
  } satisfies NodeJS.ProcessEnv
}

export const GrepTool = Tool.define(
  "grep",
  // @ts-expect-error - Zod params accepted at runtime; PawWork keeps grep on Zod for its Ripgrep adapter
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        pattern: z.string().describe("The regex pattern to search for in file contents"),
        path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
        include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
      }),
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          const search = AppFileSystem.resolve(
            path.isAbsolute(params.path ?? ins.directory)
              ? (params.path ?? ins.directory)
              : path.join(ins.directory, params.path ?? "."),
          )
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          const file = info?.type === "Directory" ? undefined : [path.relative(cwd, search)]
          yield* assertExternalDirectoryEffect(ctx, search, {
            kind: info?.type === "Directory" ? "directory" : "file",
          })

          const rgPath = yield* Effect.promise(() => Ripgrep.filepath())
          const args = ["--json", "--hidden", "--glob=!.git/*"]
          if (params.include) {
            args.push("--glob", params.include)
          }
          args.push("--", params.pattern)
          if (file) args.push(...file)

          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              ctx.abort.throwIfAborted()
              const handle = yield* spawner.spawn(
                ChildProcess.make(rgPath, args, {
                  cwd,
                  env: ripgrepEnv(),
                  stdin: "ignore",
                }),
              )

              const outputFiber = yield* Stream.mkString(Stream.decodeText(handle.stdout)).pipe(Effect.forkScoped)
              const errorFiber = yield* Stream.mkString(Stream.decodeText(handle.stderr)).pipe(Effect.forkScoped)

              const abort = Effect.callback<void>((resume) => {
                if (ctx.abort.aborted) return resume(Effect.void)
                const handler = () => resume(Effect.void)
                ctx.abort.addEventListener("abort", handler, { once: true })
                return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
              })

              const exit = yield* Effect.raceAll([
                handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
                abort.pipe(Effect.map(() => ({ kind: "abort" as const }))),
              ])

              if (exit.kind === "abort") {
                yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
                return yield* Effect.fail(new DOMException("This operation was aborted", "AbortError"))
              }

              const output = yield* Fiber.join(outputFiber)
              const errorOutput = yield* Fiber.join(errorFiber)

              return { output, errorOutput, exitCode: exit.code }
            }),
          )

          const { output, errorOutput, exitCode } = result

          if (exitCode === 1) return empty

          if (exitCode === 2 && !output.trim()) {
            throw new Error(`ripgrep failed: ${errorOutput.trim() || "unknown error"}`)
          }

          if (exitCode !== 0 && exitCode !== 2) {
            throw new Error(`ripgrep failed: ${errorOutput}`)
          }

          const hasErrors = exitCode === 2

          const lines = output.trim().split(/\r?\n/).filter(Boolean)
          const rows = lines.flatMap((line) => {
            try {
              const parsed = JSON.parse(line)
              const match = Ripgrep.Match.parse(parsed).data
              return [
                {
                  path: AppFileSystem.resolve(
                    path.isAbsolute(match.path.text) ? match.path.text : path.join(cwd, match.path.text),
                  ),
                  line: match.line_number,
                  text: match.lines.text,
                },
              ]
            } catch {
              return []
            }
          })
          if (rows.length === 0) return empty

          const times = new Map(
            (yield* Effect.forEach(
              [...new Set(rows.map((row) => row.path))],
              Effect.fnUntraced(function* (filePath) {
                const stat = yield* fs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!stat || stat.type === "Directory") return undefined
                return [
                  filePath,
                  stat.mtime.pipe(
                    Option.map((time) => time.getTime()),
                    Option.getOrElse(() => 0),
                  ) ?? 0,
                ] as const
              }),
              { concurrency: 16 },
            )).filter((entry): entry is readonly [string, number] => Boolean(entry)),
          )
          const matches = rows.flatMap((row) => {
            const mtime = times.get(row.path)
            if (mtime === undefined) return []
            return [{ ...row, mtime }]
          })

          matches.sort((a, b) => b.mtime - a.mtime)

          const limit = 100
          const truncated = matches.length > limit
          const finalMatches = truncated ? matches.slice(0, limit) : matches
          if (finalMatches.length === 0) return empty

          const totalMatches = matches.length
          const outputLines = [`Found ${totalMatches} matches${truncated ? ` (showing first ${limit})` : ""}`]

          let currentFile = ""
          for (const match of finalMatches) {
            if (currentFile !== match.path) {
              if (currentFile !== "") {
                outputLines.push("")
              }
              currentFile = match.path
              outputLines.push(`${match.path}:`)
            }
            const truncatedLineText =
              match.text.length > MAX_LINE_LENGTH ? match.text.substring(0, MAX_LINE_LENGTH) + "..." : match.text
            outputLines.push(`  Line ${match.line}: ${truncatedLineText}`)
          }

          if (truncated) {
            outputLines.push("")
            outputLines.push(
              `(Results truncated: showing ${limit} of ${totalMatches} matches (${totalMatches - limit} hidden). Consider using a more specific path or pattern.)`,
            )
          }

          if (hasErrors) {
            outputLines.push("")
            outputLines.push("(Some paths were inaccessible and skipped)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: totalMatches,
              truncated,
            },
            output: outputLines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
