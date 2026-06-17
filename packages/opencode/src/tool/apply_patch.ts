import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "../lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import * as Bom from "@/util/bom"
import { isSensitiveTargetPath, type SensitiveStatus } from "./sensitive"
import { TurnChange } from "@/session/turn-change"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

function statusFromPatchType(type: "add" | "update" | "delete" | "move"): SensitiveStatus {
  if (type === "add") return "added"
  if (type === "delete") return "deleted"
  return "modified"
}

function isSensitiveFile(filePath: string) {
  return isSensitiveTargetPath(filePath, Instance.worktree)
}

function notFound(error: unknown) {
  if (typeof error !== "object" || error === null || !("reason" in error)) return false
  const reason = (error as Record<string, unknown>).reason
  return typeof reason === "object" && reason !== null && "_tag" in reason && reason._tag === "NotFound"
}

function safeTotalDiff(changes: Array<{ diff: string; sensitive: boolean }>) {
  return changes
    .filter((change) => !change.sensitive)
    .map((change) => change.diff + (change.diff.endsWith("\n") ? "" : "\n"))
    .join("")
}

const VERIFICATION_ERROR_PREFIX = "apply_patch verification failed:"

function verificationError(error: unknown) {
  if (error instanceof Error && error.message.startsWith(VERIFICATION_ERROR_PREFIX)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${VERIFICATION_ERROR_PREFIX} ${message}`, { cause: error })
}

const parseHunks = Effect.fn("ApplyPatchTool.parseHunks")(function* (patchText: string) {
  return yield* Effect.try({
    try: () => Patch.parsePatch(patchText).hunks,
    catch: verificationError,
  })
})

const deriveNewContents = Effect.fn("ApplyPatchTool.deriveNewContents")(function* (
  filePath: string,
  chunks: Patch.UpdateFileChunk[],
) {
  return yield* Effect.try({
    try: () => Patch.deriveNewContentsFromChunks(filePath, chunks),
    catch: verificationError,
  })
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const turnChange = yield* TurnChange.Service

    const execute = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      const hunks = yield* parseHunks(params.patchText)

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error(`${VERIFICATION_ERROR_PREFIX} no hunks found`))
      }

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
        beforeExists: boolean
        beforeContent?: string
        beforeBom: boolean
        moveBeforeContent?: string
        moveBeforeBom?: boolean
        moveBeforeExists?: boolean
        sensitive: boolean
      }> = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const rawFilePath = path.resolve(Instance.directory, hunk.path)
        const filePath = (yield* assertExternalDirectoryEffect(ctx, rawFilePath)) ?? rawFilePath

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const existing = yield* Bom.readFile(afs, filePath).pipe(
              Effect.catchIf(notFound, () => Effect.succeed(undefined)),
            )
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              additions,
              deletions,
              bom: next.bom,
              beforeExists: !!existing,
              beforeContent: existing?.text,
              beforeBom: existing?.bom ?? false,
              moveBeforeExists: undefined,
              sensitive: isSensitiveFile(filePath),
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`${VERIFICATION_ERROR_PREFIX} Failed to read file to update: ${filePath}`),
              )
            }

            const source = yield* Bom.readFile(afs, filePath)
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom

            // Apply the update chunks to get new content
            const fileUpdate = yield* deriveNewContents(filePath, hunk.chunks)
            newContent = fileUpdate.content
            bom = fileUpdate.bom

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const rawMovePath = hunk.move_path ? path.resolve(Instance.directory, hunk.move_path) : undefined
            const movePath = rawMovePath
              ? ((yield* assertExternalDirectoryEffect(ctx, rawMovePath)) ?? rawMovePath)
              : undefined
            const moveBefore = movePath
              ? yield* Bom.readFile(afs, movePath).pipe(Effect.catchIf(notFound, () => Effect.succeed(undefined)))
              : undefined

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom,
              beforeExists: true,
              beforeBom: source.bom,
              moveBeforeContent: moveBefore?.text,
              moveBeforeBom: moveBefore?.bom,
              moveBeforeExists: !!moveBefore,
              sensitive: isSensitiveFile(filePath) || (movePath ? isSensitiveFile(movePath) : false),
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const source = yield* Bom.readFile(afs, filePath).pipe(
              Effect.catch((error) => Effect.fail(verificationError(error))),
            )
            const contentToDelete = source.text
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: source.bom,
              beforeExists: true,
              beforeBom: source.bom,
              sensitive: isSensitiveFile(filePath),
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files: Array<Record<string, unknown>> = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        ...(change.sensitive
          ? {
              status: statusFromPatchType(change.type),
              sensitive: true,
              ...(change.movePath ? { movePath: change.movePath } : {}),
            }
          : {
              patch: change.diff,
              additions: change.additions,
              deletions: change.deletions,
              movePath: change.movePath,
            }),
      }))

      // Check permissions — include `movePath` so a `move` hunk can't relocate
      // a file into a destination the current edit policy would have denied
      // (the `permission` rules apply to `patterns`, so leaving movePath out
      // would let an attacker craft `move src/regular.ts -> .opencode/secret`
      // and have the user only see `src/regular.ts` in the approval prompt).
      const relativePaths = [
        ...new Set(
          fileChanges.flatMap((c) => [
            path.relative(Instance.worktree, c.filePath).replaceAll("\\", "/"),
            ...(c.movePath ? [path.relative(Instance.worktree, c.movePath).replaceAll("\\", "/")] : []),
          ]),
        ),
      ]
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          ...(safeTotalDiff(fileChanges) ? { diff: safeTotalDiff(fileChanges) } : {}),
          files,
        },
      })

      // Apply the changes
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

      for (const change of fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          case "add":
            // Create parent directories (recursive: true is safe on existing/root dirs)

            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            updates.push({ file: change.filePath, event: "add" })
            break

          case "update":
            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            updates.push({ file: change.filePath, event: "change" })
            break

          case "move":
            if (change.movePath) {
              // Create parent directories (recursive: true is safe on existing/root dirs)

              yield* afs.writeWithDirs(change.movePath!, Bom.join(change.newContent, change.bom))
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          case "delete":
            yield* afs.remove(change.filePath)
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        if (edited) {
          yield* bus.publish(File.Event.Edited, { file: edited })
        }

        if (change.type === "move" && change.movePath) {
          yield* turnChange.recordWrite({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            path: change.filePath,
            before: { exists: true, content: change.oldContent, bom: change.beforeBom },
            after: { exists: false },
          })
          yield* turnChange.recordWrite({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            path: change.movePath,
            before: change.moveBeforeExists
              ? { exists: true, content: change.moveBeforeContent ?? "", bom: change.moveBeforeBom ?? false }
              : { exists: false },
            after: { exists: true, content: change.newContent, bom: change.bom },
          })
        } else {
          yield* turnChange.recordWrite({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            path: change.filePath,
            before: change.beforeExists
              ? { exists: true, content: change.beforeContent ?? change.oldContent, bom: change.beforeBom }
              : { exists: false },
            after:
              change.type === "delete"
                ? { exists: false }
                : { exists: true, content: change.newContent, bom: change.bom },
          })
        }
      }

      // Rebuild the aggregated diff and per-file metadata.
      totalDiff = ""
      for (let i = 0; i < fileChanges.length; i++) {
        const c = fileChanges[i]!
        totalDiff += c.diff + (c.diff.endsWith("\n") ? "" : "\n")
        const f = files[i]
        if (f && !c.sensitive) {
          f.patch = c.diff
          f.additions = c.additions
          f.deletions = c.deletions
        }
      }

      // Publish file change events
      for (const update of updates) {
        yield* bus.publish(FileWatcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, true)
      }
      const diagnostics = fileChanges.some((change) => change.sensitive) ? {} : yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(Instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        if (change.sensitive) continue
        const block = LSP.Diagnostic.report(target, diagnostics[AppFileSystem.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(Instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          ...(safeTotalDiff(fileChanges) ? { diff: safeTotalDiff(fileChanges) } : {}),
          files,
          diagnostics,
        },
        output,
      }
    }, Effect.orDie)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute,
    }
  }),
)
