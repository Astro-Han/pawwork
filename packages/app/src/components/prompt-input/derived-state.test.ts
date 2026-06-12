import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { Prompt } from "@/context/prompt"
import type {
  createPromptDerivedState as createPromptDerivedStateType,
  PromptDerivedStateDeps,
} from "./derived-state"

// The real prompt context pulls client-only router APIs at module scope; this
// suite only needs the floating-attachment predicate.
mock.module("@/context/prompt", () => ({
  isFloatingAttachment: (part: { type: string }) => part.type === "image" || part.type === "attachment",
}))

let createPromptDerivedState: typeof createPromptDerivedStateType

beforeAll(async () => {
  createPromptDerivedState = (await import("./derived-state")).createPromptDerivedState
})

function makeDerivedState(prompt: Prompt) {
  const deps = {
    store: { mode: "normal" },
    prompt: {
      current: () => prompt,
      context: { items: () => [] },
    },
    sync: { session: { get: () => undefined }, data: { session_status: {} } },
    sdk: { directory: "/repo" },
    permission: {
      isAutoAcceptingDirectory: () => false,
      isAutoAccepting: () => false,
    },
    language: { t: (key: string) => key },
    activeSessionID: () => undefined,
    actionReadyProp: () => true,
    abortReadyProp: () => true,
  } as unknown as PromptDerivedStateDeps
  return createPromptDerivedState(deps)
}

describe("prompt derived state", () => {
  test("floating attachments include chips and legacy images in prompt order", () => {
    createRoot((dispose) => {
      const derived = makeDerivedState([
        { type: "text", content: "hi", start: 0, end: 2 },
        { type: "image", id: "img_1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
        { type: "attachment", id: "att_1", path: "/Users/me/b.pdf", filename: "b.pdf" },
      ])

      expect(derived.imageAttachments().map((part) => ("id" in part ? part.id : ""))).toEqual(["img_1", "att_1"])
      dispose()
    })
  })

  test("a chip-only prompt is not blank", () => {
    createRoot((dispose) => {
      const derived = makeDerivedState([
        { type: "text", content: "", start: 0, end: 0 },
        { type: "attachment", id: "att_1", path: "/Users/me/b.pdf", filename: "b.pdf" },
      ])

      expect(derived.blank()).toBe(false)
      dispose()
    })
  })
})
