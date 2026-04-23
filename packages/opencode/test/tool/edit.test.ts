import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { LSP } from "../../src/lsp"
import { AppFileSystem } from "../../src/filesystem"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Truncate } from "../../src/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { FileWatcher } from "../../src/file/watcher"
import * as Tool from "../../src/tool/tool"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
    Bus.layer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const expectRunFailure = Effect.fn("EditToolTest.expectRunFailure")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  message: string,
) {
  const exit = yield* run(args).pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.pretty(exit.cause)).toContain(message)
  }
})

type FileUpdate = {
  file: string
  event: "change" | "add" | "unlink"
}

const nextFileUpdate = <A, E, R>(check: (event: FileUpdate) => boolean, trigger: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<FileUpdate>()
      const bus = yield* Bus.Service
      const unsubscribe = yield* bus.subscribeCallback(FileWatcher.Event.Updated, (payload) => {
        if (!check(payload.properties)) return
        Deferred.doneUnsafe(deferred, Effect.succeed(payload.properties))
      })
      return { deferred, unsubscribe }
    }),
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger
        return yield* Deferred.await(deferred).pipe(Effect.timeout("5 seconds"))
      }),
    ({ unsubscribe }) => Effect.sync(unsubscribe),
  )

describe("tool.edit", () => {
  describe("creating new files", () => {
    it.live("creates new file when oldString is empty", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "newfile.txt")
          const result = yield* run({
            filePath: filepath,
            oldString: "",
            newString: "new content",
          })

          expect(result.metadata.diff).toContain("new content")

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content).toBe("new content")
        }),
      ),
    )

    it.live("creates new file with nested directories", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "nested", "dir", "file.txt")
          yield* run({
            filePath: filepath,
            oldString: "",
            newString: "nested file",
          })

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content).toBe("nested file")
        }),
      ),
    )

    it.live("emits add event for new files", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "new.txt")

          const event = yield* nextFileUpdate(
            (payload) => payload.file === filepath && payload.event === "add",
            run({
              filePath: filepath,
              oldString: "",
              newString: "content",
            }),
          )

          expect(event).toEqual({
            file: filepath,
            event: "add",
          })
        }),
      ),
    )
  })

  describe("editing existing files", () => {
    it.live("replaces text without requiring a prior read", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "existing-no-read.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "old content here", "utf-8"))

          const result = yield* run({
            filePath: filepath,
            oldString: "old content",
            newString: "new content",
          })

          expect(result.output).toContain("Edit applied successfully")

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content).toBe("new content here")
        }),
      ),
    )

    it.live("replaces text in existing file", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "existing.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "old content here", "utf-8"))

          const result = yield* run({
            filePath: filepath,
            oldString: "old content",
            newString: "new content",
          })

          expect(result.output).toContain("Edit applied successfully")

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content).toBe("new content here")
        }),
      ),
    )

    it.live("throws error when file does not exist", () =>
      provideTmpdirInstance((dir) =>
        expectRunFailure(
          {
            filePath: path.join(dir, "nonexistent.txt"),
            oldString: "old",
            newString: "new",
          },
          "not found",
        ),
      ),
    )

    it.live("throws error when oldString equals newString", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "file.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "content", "utf-8"))

          yield* expectRunFailure(
            {
              filePath: filepath,
              oldString: "same",
              newString: "same",
            },
            "identical",
          )
        }),
      ),
    )

    it.live("throws error when oldString not found in file", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "file.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "actual content", "utf-8"))

          yield* expectRunFailure(
            {
              filePath: filepath,
              oldString: "not in file",
              newString: "replacement",
            },
            "Could not find oldString",
          )
        }),
      ),
    )

    it.live("replaces all occurrences with replaceAll option", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "file.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "foo bar foo baz foo", "utf-8"))

          yield* run({
            filePath: filepath,
            oldString: "foo",
            newString: "qux",
            replaceAll: true,
          })

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content).toBe("qux bar qux baz qux")
        }),
      ),
    )

    it.live("emits change event for existing files", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "file.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "original", "utf-8"))

          const event = yield* nextFileUpdate(
            (payload) => payload.file === filepath && payload.event === "change",
            run({
              filePath: filepath,
              oldString: "original",
              newString: "modified",
            }),
          )

          expect(event).toEqual({
            file: filepath,
            event: "change",
          })
        }),
      ),
    )
  })

  describe("edge cases", () => {
    it.live("handles multiline replacements", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "file.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "line1\nline2\nline3", "utf-8"))

          yield* run({
            filePath: filepath,
            oldString: "line2",
            newString: "new line 2\nextra line",
          })

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content).toBe("line1\nnew line 2\nextra line\nline3")
        }),
      ),
    )

    it.live("handles CRLF line endings", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "file.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "line1\r\nold\r\nline3", "utf-8"))

          yield* run({
            filePath: filepath,
            oldString: "old",
            newString: "new",
          })

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content).toBe("line1\r\nnew\r\nline3")
        }),
      ),
    )

    it.live("throws error when oldString equals newString", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "file.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "content", "utf-8"))

          yield* expectRunFailure(
            {
              filePath: filepath,
              oldString: "",
              newString: "",
            },
            "identical",
          )
        }),
      ),
    )

    it.live("throws error when path is directory", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const dirpath = path.join(dir, "adir")
          yield* Effect.promise(() => fs.mkdir(dirpath))

          yield* expectRunFailure(
            {
              filePath: dirpath,
              oldString: "old",
              newString: "new",
            },
            "directory",
          )
        }),
      ),
    )

    it.live("tracks file diff statistics", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "file.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "line1\nline2\nline3", "utf-8"))

          const result = yield* run({
            filePath: filepath,
            oldString: "line2",
            newString: "new line a\nnew line b",
          })

          expect(result.metadata.filediff).toBeDefined()
          expect(result.metadata.filediff.file).toBe(filepath)
          expect(result.metadata.filediff.additions).toBeGreaterThan(0)
        }),
      ),
    )
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    const apply = (input: Input) =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filePath = path.join(dir, "test.txt")
          yield* Effect.promise(() => Bun.write(filePath, input.content))
          yield* run({
            filePath,
            oldString: input.oldString,
            newString: input.newString,
            replaceAll: input.replaceAll,
          })
          return yield* Effect.promise(() => Bun.file(filePath).text())
        }),
      )

    it.live("preserves LF with LF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.live("preserves CRLF with CRLF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.live("preserves LF when old/new use CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.live("preserves CRLF when old/new use LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.live("preserves LF when newString uses CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.live("preserves CRLF when newString uses LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.live("preserves LF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: "alpha\nbeta\r\ngamma",
          newString: "alpha\r\nbeta\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.live("preserves CRLF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: "alpha\r\nbeta\ngamma",
          newString: "alpha\nbeta\r\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.live("replaceAll preserves LF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\n"),
          newString: normalize(blockNew, "\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.live("replaceAll preserves CRLF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\r\n"),
          newString: normalize(blockNew, "\r\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )
  })

  describe("concurrent editing", () => {
    it.live("serializes concurrent edits to same file", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "file.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "0", "utf-8"))

          const results = yield* Effect.all(
            [
              run({
                filePath: filepath,
                oldString: "0",
                newString: "1",
              }).pipe(Effect.exit),
              run({
                filePath: filepath,
                oldString: "0",
                newString: "2",
              }).pipe(Effect.exit),
            ],
            { concurrency: 2 },
          )

          expect(results.filter((result) => Exit.isSuccess(result))).toHaveLength(1)
          expect(results.filter((result) => Exit.isFailure(result))).toHaveLength(1)

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(["1", "2"]).toContain(content)
        }),
      ),
    )
  })
})
