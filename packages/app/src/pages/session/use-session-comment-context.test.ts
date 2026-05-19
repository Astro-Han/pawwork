import { describe, expect, test } from "bun:test"
import { createSessionCommentContext } from "./use-session-comment-context"

describe("session comment context", () => {
  test("adds comments with preview from selected file content", () => {
    const added: unknown[] = []
    const promptAdds: unknown[] = []
    const controller = createSessionCommentContext({
      attachmentLabel: () => "Attachment",
      sourceFilesystemDirectory: () => "/repo",
      getFileContent: () => "one\ntwo\nthree\n",
      comments: {
        add(input) {
          added.push(input)
          return { id: "c1" }
        },
        update() {},
        remove() {},
      },
      promptContext: {
        add(input) {
          promptAdds.push(input)
        },
        updateComment() {},
        removeComment() {},
      },
    })

    controller.add({
      file: "src/a.ts",
      selection: { start: 2, end: 2 },
      comment: "check this",
      origin: "review",
    })

    expect(added).toEqual([{ file: "src/a.ts", selection: { start: 2, end: 2 }, comment: "check this" }])
    expect(promptAdds[0]).toMatchObject({
      type: "file",
      path: "src/a.ts",
      comment: "check this",
      commentID: "c1",
      commentOrigin: "review",
      preview: "two",
    })
  })

  test("updates and removes prompt comment context", () => {
    const updated: unknown[] = []
    const removed: unknown[] = []
    const controller = createSessionCommentContext({
      attachmentLabel: () => "Attachment",
      sourceFilesystemDirectory: () => "/repo",
      getFileContent: () => undefined,
      comments: {
        add() {
          return { id: "unused" }
        },
        update(file, id, comment) {
          updated.push({ file, id, comment })
        },
        remove(file, id) {
          removed.push({ file, id })
        },
      },
      promptContext: {
        add() {},
        updateComment(file, id, patch) {
          updated.push({ file, id, patch })
        },
        removeComment(file, id) {
          removed.push({ file, id })
        },
      },
    })

    controller.update({ id: "c1", file: "src/a.ts", selection: { start: 1, end: 1 }, comment: "new", preview: "one" })
    controller.update({ id: "c2", file: "src/b.ts", selection: { start: 1, end: 1 }, comment: "blank", preview: "" })
    controller.remove({ id: "c1", file: "src/a.ts" })

    expect(updated).toContainEqual({ file: "src/a.ts", id: "c1", comment: "new" })
    expect(updated).toContainEqual({
      file: "src/a.ts",
      id: "c1",
      patch: { comment: "new", preview: "one", resolvedMentions: [] },
    })
    expect(updated).toContainEqual({
      file: "src/b.ts",
      id: "c2",
      patch: { comment: "blank", preview: "", resolvedMentions: [] },
    })
    expect(removed).toEqual([
      { file: "src/a.ts", id: "c1" },
      { file: "src/a.ts", id: "c1" },
    ])
  })

  test("add captures @mention metadata using the source workspace directory", () => {
    const promptAdds: Array<{ resolvedMentions?: Array<{ resolvedPath: string }> }> = []
    const controller = createSessionCommentContext({
      attachmentLabel: () => "Attachment",
      sourceFilesystemDirectory: () => "/repo-A",
      getFileContent: () => "x",
      comments: { add: () => ({ id: "c1" }), update() {}, remove() {} },
      promptContext: {
        add(entry) {
          promptAdds.push(entry)
        },
        updateComment() {},
        removeComment() {},
      },
    })

    controller.add({
      file: "src/main.ts",
      selection: { start: 1, end: 1 },
      comment: "see @src/shared.ts",
    })

    expect(promptAdds[0]?.resolvedMentions?.length).toBe(1)
    expect(promptAdds[0]?.resolvedMentions?.[0]?.resolvedPath).toBe("/repo-A/src/shared.ts")
  })

  test("update recaptures @mention metadata so stale references are dropped", () => {
    const patches: Array<{ resolvedMentions?: unknown[] }> = []
    const controller = createSessionCommentContext({
      attachmentLabel: () => "Attachment",
      sourceFilesystemDirectory: () => "/repo-A",
      getFileContent: () => "x",
      comments: { add: () => ({ id: "c1" }), update() {}, remove() {} },
      promptContext: {
        add() {},
        updateComment(_file, _id, patch) {
          patches.push(patch as { resolvedMentions?: unknown[] })
        },
        removeComment() {},
      },
    })

    // First update keeps the mention.
    controller.update({
      id: "c1",
      file: "src/main.ts",
      selection: { start: 1, end: 1 },
      comment: "see @src/shared.ts",
    })
    expect(patches[0]?.resolvedMentions?.length).toBe(1)

    // Second update removes the mention; resolvedMentions must be an empty
    // array so the old metadata is overwritten, not preserved.
    controller.update({
      id: "c1",
      file: "src/main.ts",
      selection: { start: 1, end: 1 },
      comment: "no mention any more",
    })
    expect(patches[1]?.resolvedMentions).toEqual([])
  })
})
