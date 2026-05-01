import * as path from "path"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const GIT_PROBE_TIMEOUT = "5 seconds"
type Spawner = ChildProcessSpawner["Service"]

const gitOutput = Effect.fn("EnterWorktree.gitOutput")(function* (spawner: Spawner, args: string[], cwd: string) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, extendEnv: true, stdin: "ignore" }))
      const [stdout, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
        concurrency: 2,
      })
      if (code !== 0) return undefined
      const out = stdout.trim()
      return out || undefined
    }),
  )
})

export const gitCommonDir = Effect.fn("EnterWorktree.gitCommonDir")(function* (spawner: Spawner, cwd: string) {
  const out = yield* gitOutput(spawner, ["rev-parse", "--git-common-dir"], cwd).pipe(
    Effect.timeout(GIT_PROBE_TIMEOUT),
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (!out) return undefined
  return path.resolve(cwd, out)
})

export const currentBranch = Effect.fn("EnterWorktree.currentBranch")(function* (spawner: Spawner, cwd: string) {
  return yield* gitOutput(spawner, ["rev-parse", "--abbrev-ref", "HEAD"], cwd).pipe(
    Effect.timeout(GIT_PROBE_TIMEOUT),
    Effect.catch(() => Effect.succeed("")),
    Effect.map((out) => out ?? ""),
  )
})
