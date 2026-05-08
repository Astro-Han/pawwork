import path from "path"
import { realpathSync } from "fs"
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

function resolveForPermission(target: string, base: string): string {
  const normalized = process.platform === "win32" ? AppFileSystem.normalizePath(target, { base }) : path.resolve(target)
  const missing: string[] = []
  let current = normalized

  while (true) {
    try {
      const real = process.platform === "win32" ? realpathSync.native(current) : realpathSync(current)
      const resolved = process.platform === "win32" ? AppFileSystem.normalizePath(real, { base }) : real
      return missing.length === 0 ? resolved : path.join(resolved, ...missing.reverse())
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error
      const parent = path.dirname(current)
      if (parent === current) return normalized
      missing.push(path.basename(current))
      current = parent
    }
  }
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
  const resolved = resolveForPermission(full, ins.directory)
  const scope = {
    ...ins,
    directory: resolveForPermission(ins.directory, ins.directory),
    worktree: ins.worktree === "/" ? ins.worktree : resolveForPermission(ins.worktree, ins.directory),
  }
  if (options?.bypass) return full
  if (Instance.containsPath(resolved, scope)) return full

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
