import { describe, expect, test } from "bun:test"
import { createSessionCommentContext } from "./use-session-comment-context"

describe("session comment context", () => {
  test("adds comments with preview from selected file content", () => {
    const added: unknown[] = []
    const promptAdds: unknown[] = []
    const controller = createSessionCommentContext({
      attachmentLabel: () => "Attachment",
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
    expect(updated).toContainEqual({ file: "src/a.ts", id: "c1", patch: { comment: "new", preview: "one" } })
    expect(updated).toContainEqual({ file: "src/b.ts", id: "c2", patch: { comment: "blank", preview: "" } })
    expect(removed).toEqual([
      { file: "src/a.ts", id: "c1" },
      { file: "src/a.ts", id: "c1" },
    ])
  })
})
