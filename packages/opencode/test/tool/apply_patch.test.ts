import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Layer } from "effect"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { Instance } from "../../src/project/instance"
import { LSP } from "../../src/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Truncate } from "../../src/tool/truncate"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { TurnChange } from "../../src/session/turn-change"
import { testEffect } from "../lib/effect"
import * as Tool from "../../src/tool/tool"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"

const testLayer = Layer.mergeAll(
  LSP.defaultLayer,
  AppFileSystem.defaultLayer,
  Bus.layer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  TurnChange.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(testLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: {
    diff?: string
    filepath: string
    files: Array<Record<string, unknown>>
  }
}

type ToolCtx = typeof baseCtx & {
  ask: (input: AskInput) => Effect.Effect<void>
}

const init = Effect.fn("ApplyPatchToolTest.init")(function* () {
  const info = yield* ApplyPatchTool
  return yield* info.init()
})

const execute = Effect.fn("ApplyPatchToolTest.execute")(function* (
  params: Tool.InferParameters<typeof ApplyPatchTool>,
  ctx: ToolCtx,
) {
  const tool = yield* init()
  return yield* tool.execute(params, ctx)
})

const executeFailure = Effect.fn("ApplyPatchToolTest.executeFailure")(function* (
  params: Tool.InferParameters<typeof ApplyPatchTool>,
  ctx: ToolCtx,
) {
  const exit = yield* execute(params, ctx).pipe(Effect.exit)
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure") throw new Error("expected apply_patch to fail")
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error : new Error(String(error))
})

const writeFile = Effect.fn("ApplyPatchToolTest.writeFile")(function* (filePath: string, content: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeFileString(filePath, content)
})
const readFile = Effect.fn("ApplyPatchToolTest.readFile")(function* (filePath: string) {
  const fs = yield* AppFileSystem.Service
  return yield* fs.readFileString(filePath)
})
const mkdir = Effect.fn("ApplyPatchToolTest.mkdir")(function* (
  filePath: string,
  options?: { recursive?: boolean },
) {
  const fs = yield* AppFileSystem.Service
  yield* fs.makeDirectory(filePath, options)
})
const expectReadFileRejects = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const exists = yield* fs.readFileString(filePath).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    )
    expect(exists).toBe(false)
  })

const makeCtx = () => {
  const calls: AskInput[] = []
  const ctx: ToolCtx = {
    ...baseCtx,
    ask: (input) =>
      Effect.sync(() => {
        calls.push(input)
      }),
  }

  return { ctx, calls }
}

describe("tool.apply_patch freeform", () => {
  it.live("initializes through Effect and preserves the current defectified execute boundary", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()

      const exit = yield* execute({ patchText: "invalid patch" }, ctx).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain("apply_patch verification failed")
      }
    }),
  )

  it.live("requires patchText", () => Effect.gen(function* () {
    const { ctx } = makeCtx()
    expect((yield* executeFailure({ patchText: "" }, ctx)).message).toContain("patchText is required")
  }))

  it.live("rejects invalid patch format", () => Effect.gen(function* () {
    const { ctx } = makeCtx()
    expect(yield* executeFailure({ patchText: "invalid patch" }, ctx)).toMatchObject({
      message: "apply_patch verification failed: Invalid patch format: missing Begin/End markers",
      cause: expect.objectContaining({
        message: "Invalid patch format: missing Begin/End markers",
      }),
    })
  }))

  it.live("rejects empty patch", () => Effect.gen(function* () {
    const { ctx } = makeCtx()
    const emptyPatch = "*** Begin Patch\n*** End Patch"
    expect((yield* executeFailure({ patchText: emptyPatch }, ctx)).message).toContain("patch rejected: empty patch")
  }))

  it.live("applies add/update/delete in one patch", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const { ctx, calls } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const modifyPath = path.join(dir, "modify.txt")
        const deletePath = path.join(dir, "delete.txt")
        yield* writeFile(modifyPath, "line1\nline2\n")
        yield* writeFile(deletePath, "obsolete\n")

        const patchText =
          "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** End Patch"

        const result = yield* execute({ patchText }, ctx)

        expect(result.title).toContain("Success. Updated the following files")
        expect(result.output).toContain("Success. Updated the following files")
        // Strict formatting assertions for slashes
        expect(result.output).toMatch(/A nested\/new\.txt/)
        expect(result.output).toMatch(/D delete\.txt/)
        expect(result.output).toMatch(/M modify\.txt/)
        if (process.platform === "win32") {
          expect(result.output).not.toContain("\\")
        }
        expect(result.metadata.diff).toContain("Index:")
        expect(calls.length).toBe(1)

        // Verify permission metadata includes files array for UI rendering
        const permissionCall = calls[0]
        expect(permissionCall.metadata.files).toHaveLength(3)
        expect(permissionCall.metadata.files.map((f) => f.type).sort()).toEqual(["add", "delete", "update"])

        const addFile = permissionCall.metadata.files.find((f) => f.type === "add")
        expect(addFile).toBeDefined()
        expect(addFile!.relativePath).toBe("nested/new.txt")
        expect(addFile!.patch).toContain("+created")

        const updateFile = permissionCall.metadata.files.find((f) => f.type === "update")
        expect(updateFile).toBeDefined()
        expect(updateFile!.patch).toContain("-line2")
        expect(updateFile!.patch).toContain("+changed")

        const added = yield* readFile(path.join(dir, "nested", "new.txt"))
        expect(added).toBe("created\n")
        expect(yield* readFile(modifyPath)).toBe("line1\nchanged\n")
        yield* expectReadFileRejects(deletePath)
      }),
    )
  }))

  it.live("redacts sensitive file permission and result metadata", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const { ctx, calls } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, ".env")
        yield* writeFile(target, "TOKEN=old-secret\n")

        const patchText = "*** Begin Patch\n*** Update File: .env\n@@\n-TOKEN=old-secret\n+TOKEN=new-secret\n*** End Patch"
        const result = yield* execute({ patchText }, ctx)
        const serialized = JSON.stringify({ calls, result })

        expect(calls).toHaveLength(1)
        expect(calls[0].metadata).toEqual({
          filepath: ".env",
          files: [
            {
              filePath: target,
              relativePath: ".env",
              type: "update",
              status: "modified",
              sensitive: true,
            },
          ],
        })
        expect((result.metadata as any).files).toEqual([
          {
            filePath: target,
            relativePath: ".env",
            type: "update",
            status: "modified",
            sensitive: true,
          },
        ])
        expect(serialized).not.toContain("old-secret")
        expect(serialized).not.toContain("new-secret")
        expect(serialized).not.toContain("@@")
      }),
    )
  }))

  it.live("permission metadata includes move file info", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const { ctx, calls } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const original = path.join(dir, "old", "name.txt")
        yield* mkdir(path.dirname(original), { recursive: true })
        yield* writeFile(original, "old content\n")

        const patchText =
          "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

        yield* execute({ patchText }, ctx)

        expect(calls.length).toBe(1)
        const permissionCall = calls[0]
        expect(permissionCall.metadata.files).toHaveLength(1)

        const moveFile = permissionCall.metadata.files[0]
        expect(moveFile.type).toBe("move")
        expect(moveFile.relativePath).toBe("renamed/dir/name.txt")
        expect(moveFile.movePath).toBe(path.join(dir, "renamed/dir/name.txt"))
        expect(moveFile.patch).toContain("-old content")
        expect(moveFile.patch).toContain("+new content")
      }),
    )
  }))

  it.live("applies multiple hunks to one file", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "multi.txt")
        yield* writeFile(target, "line1\nline2\nline3\nline4\n")

        const patchText =
          "*** Begin Patch\n*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4\n*** End Patch"

        yield* execute({ patchText }, ctx)

        expect(yield* readFile(target)).toBe("line1\nchanged2\nline3\nchanged4\n")
      }),
    )
  }))

  it.live("inserts lines with insert-only hunk", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "insert_only.txt")
        yield* writeFile(target, "alpha\nomega\n")

        const patchText = "*** Begin Patch\n*** Update File: insert_only.txt\n@@\n alpha\n+beta\n omega\n*** End Patch"

        yield* execute({ patchText }, ctx)

        expect(yield* readFile(target)).toBe("alpha\nbeta\nomega\n")
      }),
    )
  }))

  it.live("appends trailing newline on update", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "no_newline.txt")
        yield* writeFile(target, "no newline at end")

        const patchText =
          "*** Begin Patch\n*** Update File: no_newline.txt\n@@\n-no newline at end\n+first line\n+second line\n*** End Patch"

        yield* execute({ patchText }, ctx)

        const contents = yield* readFile(target)
        expect(contents.endsWith("\n")).toBe(true)
        expect(contents).toBe("first line\nsecond line\n")
      }),
    )
  }))

  it.live("moves file to a new directory", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const original = path.join(dir, "old", "name.txt")
        yield* mkdir(path.dirname(original), { recursive: true })
        yield* writeFile(original, "old content\n")

        const patchText =
          "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

        yield* execute({ patchText }, ctx)

        const moved = path.join(dir, "renamed", "dir", "name.txt")
        yield* expectReadFileRejects(original)
        expect(yield* readFile(moved)).toBe("new content\n")
      }),
    )
  }))

  it.live("moves file overwriting existing destination", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const original = path.join(dir, "old", "name.txt")
        const destination = path.join(dir, "renamed", "dir", "name.txt")
        yield* mkdir(path.dirname(original), { recursive: true })
        yield* mkdir(path.dirname(destination), { recursive: true })
        yield* writeFile(original, "from\n")
        yield* writeFile(destination, "existing\n")

        const patchText =
          "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-from\n+new\n*** End Patch"

        yield* execute({ patchText }, ctx)

        yield* expectReadFileRejects(original)
        expect(yield* readFile(destination)).toBe("new\n")
      }),
    )
  }))

  it.live("adds file overwriting existing file", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "duplicate.txt")
        yield* writeFile(target, "old content\n")

        const patchText = "*** Begin Patch\n*** Add File: duplicate.txt\n+new content\n*** End Patch"

        yield* execute({ patchText }, ctx)
        expect(yield* readFile(target)).toBe("new content\n")
      }),
    )
  }))

  it.live("rejects add when existing target cannot be read as a file before asking permission", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx, calls } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        yield* mkdir(path.join(dir, "blocked.txt"))
        const patchText = "*** Begin Patch\n*** Add File: blocked.txt\n+new content\n*** End Patch"

        yield* executeFailure({ patchText }, ctx)

        expect(calls).toHaveLength(0)
      }),
    )
  }))

  it.live("rejects update when target file is missing", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const patchText = "*** Begin Patch\n*** Update File: missing.txt\n@@\n-nope\n+better\n*** End Patch"

        expect((yield* executeFailure({ patchText }, ctx)).message).toContain(
          "apply_patch verification failed: Failed to read file to update",
        )
      }),
    )
  }))

  it.live("rejects delete when file is missing", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const patchText = "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch"

        yield* executeFailure({ patchText }, ctx)
      }),
    )
  }))

  it.live("rejects delete when target is a directory", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const dirPath = path.join(dir, "dir")
        yield* mkdir(dirPath)

        const patchText = "*** Begin Patch\n*** Delete File: dir\n*** End Patch"

        yield* executeFailure({ patchText }, ctx)
      }),
    )
  }))

  it.live("rejects invalid hunk header", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const patchText = "*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch"

        expect((yield* executeFailure({ patchText }, ctx)).message).toContain("apply_patch verification failed")
      }),
    )
  }))

  it.live("rejects update with missing context", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "modify.txt")
        yield* writeFile(target, "line1\nline2\n")

        const patchText = "*** Begin Patch\n*** Update File: modify.txt\n@@\n-missing\n+changed\n*** End Patch"

        expect((yield* executeFailure({ patchText }, ctx)).message).toContain("apply_patch verification failed")
        expect(yield* readFile(target)).toBe("line1\nline2\n")
      }),
    )
  }))

  it.live("verification failure leaves no side effects", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const patchText =
          "*** Begin Patch\n*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"

        yield* executeFailure({ patchText }, ctx)

        const createdPath = path.join(dir, "created.txt")
        yield* expectReadFileRejects(createdPath)
      }),
    )
  }))

  it.live("supports end of file anchor", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "tail.txt")
        yield* writeFile(target, "alpha\nlast\n")

        const patchText = "*** Begin Patch\n*** Update File: tail.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"

        yield* execute({ patchText }, ctx)
        expect(yield* readFile(target)).toBe("alpha\nend\n")
      }),
    )
  }))

  it.live("rejects missing second chunk context", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "two_chunks.txt")
        yield* writeFile(target, "a\nb\nc\nd\n")

        const patchText = "*** Begin Patch\n*** Update File: two_chunks.txt\n@@\n-b\n+B\n\n-d\n+D\n*** End Patch"

        yield* executeFailure({ patchText }, ctx)
        expect(yield* readFile(target)).toBe("a\nb\nc\nd\n")
      }),
    )
  }))

  it.live("disambiguates change context with @@ header", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "multi_ctx.txt")
        yield* writeFile(target, "fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n")

        const patchText = "*** Begin Patch\n*** Update File: multi_ctx.txt\n@@ fn b\n-x=10\n+x=11\n*** End Patch"

        yield* execute({ patchText }, ctx)
        expect(yield* readFile(target)).toBe("fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n")
      }),
    )
  }))

  it.live("EOF anchor matches from end of file first", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "eof_anchor.txt")
        // File has duplicate "marker" lines - one in middle, one at end
        yield* writeFile(target, "start\nmarker\nmiddle\nmarker\nend\n")

        // With EOF anchor, should match the LAST "marker" line, not the first
        const patchText =
          "*** Begin Patch\n*** Update File: eof_anchor.txt\n@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File\n*** End Patch"

        yield* execute({ patchText }, ctx)
        // First marker unchanged, second marker changed
        expect(yield* readFile(target)).toBe("start\nmarker\nmiddle\nmarker-changed\nend\n")
      }),
    )
  }))

  it.live("parses heredoc-wrapped patch", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const patchText = `cat <<'EOF'
*** Begin Patch
*** Add File: heredoc_test.txt
+heredoc content
*** End Patch
EOF`

        yield* execute({ patchText }, ctx)
        const content = yield* readFile(path.join(dir, "heredoc_test.txt"))
        expect(content).toBe("heredoc content\n")
      }),
    )
  }))

  it.live("parses heredoc-wrapped patch without cat", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const patchText = `<<EOF
*** Begin Patch
*** Add File: heredoc_no_cat.txt
+no cat prefix
*** End Patch
EOF`

        yield* execute({ patchText }, ctx)
        const content = yield* readFile(path.join(dir, "heredoc_no_cat.txt"))
        expect(content).toBe("no cat prefix\n")
      }),
    )
  }))

  it.live("matches with trailing whitespace differences", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "trailing_ws.txt")
        // File has trailing spaces on some lines
        yield* writeFile(target, "line1  \nline2\nline3   \n")

        // Patch doesn't have trailing spaces - should still match via rstrip pass
        const patchText = "*** Begin Patch\n*** Update File: trailing_ws.txt\n@@\n-line2\n+changed\n*** End Patch"

        yield* execute({ patchText }, ctx)
        expect(yield* readFile(target)).toBe("line1  \nchanged\nline3   \n")
      }),
    )
  }))

  it.live("matches with leading whitespace differences", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "leading_ws.txt")
        // File has leading spaces
        yield* writeFile(target, "  line1\nline2\n  line3\n")

        // Patch without leading spaces - should match via trim pass
        const patchText = "*** Begin Patch\n*** Update File: leading_ws.txt\n@@\n-line2\n+changed\n*** End Patch"

        yield* execute({ patchText }, ctx)
        expect(yield* readFile(target)).toBe("  line1\nchanged\n  line3\n")
      }),
    )
  }))

  it.live("matches with Unicode punctuation differences", () => Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const { ctx } = makeCtx()

    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const target = path.join(dir, "unicode.txt")
        // File has fancy Unicode quotes (U+201C, U+201D) and em-dash (U+2014)
        const leftQuote = "\u201C"
        const rightQuote = "\u201D"
        const emDash = "\u2014"
        yield* writeFile(target, `He said ${leftQuote}hello${rightQuote}\nsome${emDash}dash\nend\n`)

        // Patch uses ASCII equivalents - should match via normalized pass
        // The replacement uses ASCII quotes from the patch (not preserving Unicode)
        const patchText =
          '*** Begin Patch\n*** Update File: unicode.txt\n@@\n-He said "hello"\n+He said "hi"\n*** End Patch'

        yield* execute({ patchText }, ctx)
        // Result has ASCII quotes because that's what the patch specifies
        expect(yield* readFile(target)).toBe(`He said "hi"\nsome${emDash}dash\nend\n`)
      }),
    )
  }))
})
