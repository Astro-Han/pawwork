import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { isSensitiveTargetPath, safeFilepathMetadata } from "./sensitive"
import { TurnChange } from "@/session/turn-change"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const turnChange = yield* TurnChange.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("WriteTool.execute")(function* (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ) {
        const rawFilepath = path.isAbsolute(params.filePath)
          ? params.filePath
          : path.join(Instance.directory, params.filePath)
        const filepath = (yield* assertExternalDirectoryEffect(ctx, rawFilepath)) ?? rawFilepath

        const exists = yield* fs.existsSafe(filepath)
        const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
        const next = Bom.split(params.content)
        // Only preserve the existing file's BOM. Letting `params.content`
        // introduce a new BOM (or strip an existing one) would change file
        // bytes in a way the diff preview cannot show, which can silently
        // break shebangs and first-token parsing.
        const desiredBom = source.bom
        const bomChanged = source.bom !== next.bom
        const contentOld = source.text
        const contentNew = next.text

        let diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
        const relativeFilepath = path.relative(Instance.worktree, filepath)
        const sensitive = isSensitiveTargetPath(filepath, Instance.worktree)
        const status = exists ? "modified" : "added"
        yield* ctx.ask({
          permission: "edit",
          patterns: [relativeFilepath],
          always: ["*"],
          metadata: sensitive
            ? safeFilepathMetadata(filepath, status, bomChanged ? { bomDiscarded: true } : undefined)
            : {
                filepath,
                diff,
                ...(bomChanged && { bomDiscarded: true }),
              },
        })

        yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
        yield* bus.publish(File.Event.Edited, { file: filepath })
        yield* turnChange.recordWrite({
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          path: filepath,
          before: exists ? { exists: true, content: contentOld, bom: source.bom } : { exists: false },
          after: { exists: true, content: contentNew, bom: desiredBom },
        })
        yield* bus.publish(FileWatcher.Event.Updated, {
          file: filepath,
          event: exists ? "change" : "add",
        })

        let output = "Wrote file successfully."
        yield* lsp.touchFile(filepath, true)
        const diagnostics = sensitive ? {} : yield* lsp.diagnostics()
        const normalizedFilepath = AppFileSystem.normalizePath(filepath)
        let projectDiagnosticsCount = 0
        for (const [file, issues] of Object.entries(diagnostics)) {
          const current = file === normalizedFilepath
          if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
          const block = LSP.Diagnostic.report(current ? filepath : file, issues)
          if (!block) continue
          if (current) {
            output += `\n\nLSP errors detected in this file, please fix:\n${block}`
            continue
          }
          projectDiagnosticsCount++
          output += `\n\nLSP errors detected in other files:\n${block}`
        }

        return {
          title: relativeFilepath,
          metadata: {
            diagnostics,
            ...(sensitive ? { filepath, sensitive: true, status } : { filepath }),
            exists: exists,
            ...(sensitive && bomChanged ? { bomDiscarded: true } : {}),
          },
          output,
        }
      }, Effect.orDie),
    }
  }),
)
