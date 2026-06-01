import crypto from "crypto"
import nodefs from "node:fs/promises"
import path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { FileIgnore } from "@/file/ignore"
import type { FileState } from "@/session/turn-change"
import * as Bom from "@/util/bom"
import { isOfficeCliOutputPath } from "./bash-office-artifacts"
import { Effect } from "effect"

const TRACKED_OUTPUT_LIMIT = 20 * 1024 * 1024
const AUTO_DISCOVERY_BUDGET = {
  maxFiles: 500,
  maxDirs: 80,
  maxDepth: 3,
  maxMillis: 75,
  maxCaptures: 16,
}

export type TrackedOutputState = {
  state: FileState
  comparable: boolean
  kind: "missing" | "file" | "directory" | "error"
  errorCode?: string
}

export type OutputDiscovery = {
  paths: string[]
  overflowed: boolean
}

export function isOfficeOutputPath(file: string) {
  return isOfficeCliOutputPath(file)
}

export function sameTrackedState(before: FileState, after: FileState) {
  if (!before.exists && !after.exists) return true
  return (
    before.exists === after.exists &&
    before.hash === after.hash &&
    before.bom === after.bom &&
    before.large === after.large &&
    before.binary === after.binary
  )
}

export const discoverOfficeOutputs = Effect.fn("BashOutputCapture.discoverOfficeOutputs")(
  (root: string, projectRoot: string) =>
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
          const relative = relativeDiscoveryPath(projectRoot, absolute)
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

export const readTrackedState = Effect.fn("BashOutputCapture.readTrackedState")((file: string) =>
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

function relativeDiscoveryPath(root: string, file: string) {
  return path.relative(root, file).replaceAll("\\", "/")
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
