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

type PermissionPathFs = {
  lstat: (path: string) => ReturnType<typeof lstatSync>
  realpath: (path: string) => string
}

const defaultPermissionPathFs: PermissionPathFs = {
  lstat: lstatSync,
  realpath: realpathSync.native,
}

export function resolveExternalPathForPermission(
  target: string,
  base: string,
  fs: PermissionPathFs = defaultPermissionPathFs,
): string {
  if (process.platform !== "win32") return resolvePosixForPermission(target, base, fs)
  return resolveWindowsForPermission(target, base, fs)
}

function resolveWindowsForPermission(target: string, base: string, fs: PermissionPathFs): string {
  const raw = windowsPermissionPath(target, base)
  const parsed = path.win32.parse(raw)
  if (!parsed.root) return AppFileSystem.normalizePath(raw, { base })

  const parts = raw.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)
  let current = parsed.root

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part === ".") continue
    if (part === "..") {
      current = path.win32.dirname(current)
      continue
    }

    const candidate = path.win32.join(current, part)
    try {
      const stat = fs.lstat(candidate)
      if (!stat) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      current = stat.isSymbolicLink() ? fs.realpath(candidate) : candidate
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error
      return AppFileSystem.normalizePath(path.win32.join(current, part, ...parts.slice(i + 1)), { base })
    }
  }

  try {
    return AppFileSystem.normalizePath(fs.realpath(current), { base })
  } catch {
    return AppFileSystem.normalizePath(current, { base })
  }
}

function windowsPermissionPath(target: string, base: string): string {
  const input = stripWindowsExtendedPrefix(AppFileSystem.windowsPath(target)).replaceAll("/", "\\")
  if (/^\\\\/.test(input) || /^[A-Za-z]:[\\/]/.test(input)) return uppercaseDriveRoot(input)
  const driveRelative = input.match(/^([A-Za-z]):(?![\\/])(.*)$/)
  if (driveRelative) {
    const drive = `${driveRelative[1].toUpperCase()}:`
    const baseRoot = path.win32.parse(base).root
    const baseDrive = baseRoot.slice(0, 2).toUpperCase()
    const root = drive === baseDrive ? base : `${drive}\\`
    return uppercaseDriveRoot(`${root.replace(/[\\/]+$/, "")}\\${driveRelative[2]}`)
  }
  if (/^[\\/](?![\\/])/.test(input)) {
    const root = path.win32.parse(AppFileSystem.normalizePath(base, { base })).root
    if (root) return uppercaseDriveRoot(root.replace(/[\\/]+$/, "") + input)
  }
  return uppercaseDriveRoot(`${base.replace(/[\\/]+$/, "")}\\${input}`)
}

function stripWindowsExtendedPrefix(target: string): string {
  if (/^\\\\\?\\UNC\\/i.test(target)) return target.replace(/^\\\\\?\\UNC\\/i, "\\\\")
  if (/^\\\\\?\\[A-Za-z]:\\/i.test(target)) return target.slice(4)
  return target
}

function uppercaseDriveRoot(target: string): string {
  return target.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`)
}

function resolvePosixForPermission(target: string, base: string, fs: PermissionPathFs): string {
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
      const stat = fs.lstat(candidate)
      if (!stat) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      current = stat.isSymbolicLink() ? fs.realpath(candidate) : candidate
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error
      return path.resolve(current, part, ...parts.slice(i + 1))
    }
  }

  return fs.realpath(current)
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
      ? windowsPermissionPath(target, ins.directory)
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
