import path from "path"
import { Effect } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { Instance } from "../project/instance"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return

  const ins = yield* InstanceState.context
  const full =
    process.platform === "win32"
      ? AppFileSystem.normalizePath(target, { base: ins.directory })
      : path.isAbsolute(target)
        ? target
        : path.resolve(ins.directory, target)
  const resolved = AppFileSystem.resolve(full, { base: ins.directory })
  if (options?.bypass) return full
  if (Instance.containsPath(resolved, ins)) return full

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? resolved : path.dirname(resolved)
  const glob =
    process.platform === "win32"
      ? AppFileSystem.normalizePathPattern(path.join(dir, "*"), { base: ins.directory })
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      realpath: resolved,
      parentDir: dir,
    },
  })
  return full
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options).pipe(Effect.provide(EffectLogger.layer)))
}
