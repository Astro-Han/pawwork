import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { ContextItem, Prompt } from "./prompt"

let createPromptBinding: typeof import("./prompt").createPromptBinding
let DEFAULT_PROMPT: typeof import("./prompt").DEFAULT_PROMPT

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useParams: () => ({}),
  }))
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  const mod = await import("./prompt")
  createPromptBinding = mod.createPromptBinding
  DEFAULT_PROMPT = mod.DEFAULT_PROMPT
})

function promptSession() {
  let prompt: Prompt = [{ type: "text", content: "hello", start: 0, end: 5 }]
  let cursor = 5
  let dirty = false
  const items: (ContextItem & { key: string })[] = []
  const markDirty = () => {
    dirty = true
  }

  return {
    ready: () => true,
    current: () => prompt,
    cursor: () => cursor,
    dirty: () => dirty,
    context: {
      items: () => items,
      add: (item: ContextItem) => {
        items.push({ key: item.type, ...item })
        markDirty()
      },
      remove: (key: string) => {
        const index = items.findIndex((item) => item.key === key)
        if (index >= 0) {
          items.splice(index, 1)
          markDirty()
        }
      },
      removeComment: () => markDirty(),
      updateComment: () => markDirty(),
      replaceComments: () => markDirty(),
    },
    set: (next: Prompt, nextCursor?: number) => {
      prompt = next
      cursor = nextCursor ?? cursor
      markDirty()
    },
    reset: () => {
      prompt = DEFAULT_PROMPT
      cursor = 0
      dirty = false
    },
  }
}

describe("createPromptBinding", () => {
  test("returns a safe empty prompt when the route scope is missing", () => {
    const binding = createPromptBinding(
      () => undefined,
      () => {
        throw new Error("should not load a prompt session without a directory")
      },
    )

    expect(binding.ready()).toBe(false)
    expect(binding.current()).toEqual(DEFAULT_PROMPT)
    expect(binding.cursor()).toBeUndefined()
    expect(binding.dirty()).toBe(false)
    expect(binding.context.items()).toEqual([])
    expect(() => binding.context.add({ type: "file", path: "a.ts" })).not.toThrow()
    expect(() => binding.context.remove("file")).not.toThrow()
    expect(() => binding.set([{ type: "text", content: "next", start: 0, end: 4 }], 4)).not.toThrow()
    expect(() => binding.reset()).not.toThrow()
  })

  test("uses the current route scope when it is available", () => {
    const session = promptSession()
    const binding = createPromptBinding(
      () => ({ dir: "repo", id: "session" }),
      (dir, id) => {
        expect(dir).toBe("repo")
        expect(id).toBe("session")
        return session
      },
    )

    binding.context.add({ type: "file", path: "a.ts" })

    expect(binding.ready()).toBe(true)
    expect(binding.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
    expect(binding.cursor()).toBe(5)
    expect(binding.dirty()).toBe(true)
    expect(binding.context.items().map((item) => item.path)).toEqual(["a.ts"])
  })

  test("writes to an explicit target session", () => {
    const current = promptSession()
    const target = promptSession()
    const binding = createPromptBinding(
      () => ({ dir: "repo", id: "current" }),
      (dir, id) => {
        expect(dir).toBe("repo")
        return id === "fork" ? target : current
      },
    )

    const next: Prompt = [{ type: "text", content: "forked", start: 0, end: 6 }]
    binding.set(next, 6, { dir: "repo", id: "fork" })

    expect(target.current()).toEqual(next)
    expect(target.cursor()).toBe(6)
    expect(current.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
    expect(binding.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])

    binding.reset({ dir: "repo", id: "fork" })

    expect(target.current()).toEqual(DEFAULT_PROMPT)
    expect(target.cursor()).toBe(0)
    expect(current.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
  })
})
