import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { createCommentMetadata, formatCommentNote } from "@/utils/comment-note"
import { areMessageCommentsEqual, extractMessageComments } from "./session-message-comments"

const textPart = (input: {
  text: string
  synthetic?: boolean
  metadata?: unknown
}): Part =>
  ({
    id: "prt_test",
    type: "text",
    text: input.text,
    synthetic: input.synthetic,
    metadata: input.metadata,
  }) as Part

describe("extractMessageComments", () => {
  test("extracts synthetic comment metadata", () => {
    expect(
      extractMessageComments([
        textPart({
          text: "ignored fallback",
          synthetic: true,
          metadata: createCommentMetadata({
            path: "src/app.ts",
            comment: "check this branch",
            selection: { startLine: 4, startChar: 0, endLine: 6, endChar: 0 },
          }),
        }),
      ]),
    ).toEqual([
      {
        path: "src/app.ts",
        comment: "check this branch",
        selection: { startLine: 4, endLine: 6 },
      },
    ])
  })

  test("falls back to formatted synthetic comment notes", () => {
    expect(
      extractMessageComments([
        textPart({
          text: formatCommentNote({
            path: "src/view.tsx",
            comment: "missing accessible label",
            selection: { startLine: 12, startChar: 0, endLine: 12, endChar: 0 },
          }),
          synthetic: true,
        }),
      ]),
    ).toEqual([
      {
        path: "src/view.tsx",
        comment: "missing accessible label",
        selection: { startLine: 12, endLine: 12 },
      },
    ])
  })

  test("ignores non-synthetic text parts and non-comment text", () => {
    expect(
      extractMessageComments([
        textPart({ text: formatCommentNote({ path: "src/app.ts", comment: "visible", selection: undefined }) }),
        textPart({ text: "regular assistant text", synthetic: true }),
        { id: "prt_tool", type: "tool", tool: "bash", state: { status: "pending" } } as Part,
      ]),
    ).toEqual([])
  })
})

describe("areMessageCommentsEqual", () => {
  test("compares displayed comment fields", () => {
    const comments = [
      {
        path: "src/app.ts",
        comment: "same",
        selection: { startLine: 1, endLine: 2 },
      },
    ]

    expect(areMessageCommentsEqual(comments, comments.map((comment) => ({ ...comment })))).toBe(true)
    expect(areMessageCommentsEqual(comments, [{ ...comments[0], selection: { startLine: 1, endLine: 3 } }])).toBe(
      false,
    )
  })
})
