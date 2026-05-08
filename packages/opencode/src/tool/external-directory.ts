import path from "path"
import { lstatSync, realpathSync } from "fs"
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

export function resolveExternalPathForPermission(target: string, base: string): string {
  if (process.platform !== "win32") return resolvePosixForPermission(target, base)

  const normalized = AppFileSystem.normalizePath(target, { base })
  const missing: string[] = []
  let current = normalized

  while (true) {
    try {
      const real = realpathSync.native(current)
      const resolved = AppFileSystem.normalizePath(real, { base })
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

function resolvePosixForPermission(target: string, base: string): string {
  const raw = path.isAbsolute(target) ? target : `${base.replace(/\/+$/, "")}/${target}`
  const parts = raw.split("/").filter(Boolean)
  let current = "/"

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part === ".") continue
    if (part === "..") {
      current = path.dirname(current)
      continue
    }

    const candidate = path.join(current, part)
    try {
      const stat = lstatSync(candidate)
      current = stat.isSymbolicLink() ? realpathSync.native(candidate) : candidate
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error
      return path.resolve(current, part, ...parts.slice(i + 1))
    }
  }

  return realpathSync.native(current)
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
      : `${ins.directory.replace(/\/+$/, "")}/${target}`
  const resolved = resolveExternalPathForPermission(full, ins.directory)
  const scope = {
    ...ins,
    directory: resolveExternalPathForPermission(ins.directory, ins.directory),
    worktree: ins.worktree === "/" ? ins.worktree : resolveExternalPathForPermission(ins.worktree, ins.directory),
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
