import { test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import path from "path"

const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect)

test("AppFileSystem.writeWithDirs creates parent directories", async () => {
  const live = AppFileSystem.layer.pipe(Layer.provide(NodeFileSystem.layer))

  const result = await run(
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const tmp = yield* fs.makeTempDirectoryScoped()
      const file = path.join(tmp, "deep", "nested", "file.txt")

      yield* fs.writeWithDirs(file, "hello")

      return yield* fs.readFileString(file)
    }).pipe(Effect.scoped, Effect.provide(live)),
  )

  expect(result).toBe("hello")
})
