import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { AttachmentPart, ContextItem, ImageAttachmentPart, Prompt } from "./prompt"

let createPromptBinding: typeof import("./prompt").createPromptBinding
let DEFAULT_PROMPT: typeof import("./prompt").DEFAULT_PROMPT
let isPromptEqual: typeof import("./prompt").isPromptEqual
let isStructurallyEmpty: typeof import("./prompt").isStructurallyEmpty

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  const mod = await import("./prompt")
  createPromptBinding = mod.createPromptBinding
  DEFAULT_PROMPT = mod.DEFAULT_PROMPT
  isPromptEqual = mod.isPromptEqual
  isStructurallyEmpty = mod.isStructurallyEmpty
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
    hasDraft: () => !isStructurallyEmpty(prompt, items, []),
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
      replaceAll: (next: ContextItem[]) => {
        items.splice(0, items.length, ...next.map((item) => ({ key: item.type, ...item })))
        markDirty()
      },
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

  test("shares homepage draft across workspace route changes without sharing session drafts", () => {
    let route: { dir: string; id?: string } = { dir: "repo-a" }
    const sessions = new Map<string, ReturnType<typeof promptSession>>()
    const binding = createPromptBinding(
      () => route,
      (dir, id) => {
        const key = `${dir}:${id ?? "homepage"}`
        const existing = sessions.get(key)
        if (existing) return existing
        const next = promptSession()
        next.reset()
        sessions.set(key, next)
        return next
      },
    )

    const homepageDraft: Prompt = [{ type: "text", content: "keep me visible", start: 0, end: 15 }]
    binding.set(homepageDraft, 15)
    binding.context.add({ type: "file", path: "src/app.ts" })

    route = { dir: "repo-b" }

    expect(binding.current()).toEqual(homepageDraft)
    expect(binding.context.items().map((item) => item.path)).toEqual(["src/app.ts"])

    route = { dir: "repo-b", id: "session-b" }

    expect(binding.current()).toEqual(DEFAULT_PROMPT)
    expect(binding.context.items()).toEqual([])
  })

  test("checks whether an explicit target session has a structural draft", () => {
    const current = promptSession()
    const target = promptSession()
    const binding = createPromptBinding(
      () => ({ dir: "repo", id: "current" }),
      (dir, id) => {
        expect(dir).toBe("repo")
        return id === "fork" ? target : current
      },
    )

    current.reset()
    target.reset()
    target.context.add({ type: "file", path: "target.ts" })

    expect(binding.hasDraft()).toBe(false)
    expect(binding.hasDraft({ dir: "repo", id: "fork" })).toBe(true)

    target.context.replaceAll([])
    target.set([{ type: "image", id: "img", filename: "shot.png", mime: "image/png", dataUrl: "data:" }], 0)

    expect(binding.hasDraft({ dir: "repo", id: "fork" })).toBe(true)
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

  test("replaces context on an explicit target session", () => {
    const current = promptSession()
    const target = promptSession()
    const binding = createPromptBinding(
      () => ({ dir: "repo", id: "current" }),
      (dir, id) => {
        expect(dir).toBe("repo")
        return id === "fork" ? target : current
      },
    )

    binding.context.add({ type: "file", path: "current.ts" })
    binding.context.replaceAll([{ type: "file", path: "target.ts", comment: "restore me" }], {
      dir: "repo",
      id: "fork",
    })

    expect(current.context.items().map((item) => item.path)).toEqual(["current.ts"])
    expect(target.context.items()).toMatchObject([{ type: "file", path: "target.ts", comment: "restore me" }])
  })
})

// Task 1: isPartEqual with command field
describe("isPartEqual with command field", () => {
  test("two marked TextParts with same name+source+icon are equal", () => {
    const a: Prompt = [{ type: "text", content: "/brainstorming ", start: 0, end: 15,
      command: { name: "brainstorming", source: "skill", icon: "command" } }]
    const b: Prompt = [{ type: "text", content: "/brainstorming ", start: 0, end: 15,
      command: { name: "brainstorming", source: "skill", icon: "command" } }]
    expect(isPromptEqual(a, b)).toBe(true)
  })

  test("marked vs plain TextPart with same content are NOT equal", () => {
    const marked: Prompt = [{ type: "text", content: "/brainstorming ", start: 0, end: 15,
      command: { name: "brainstorming", source: "skill", icon: "command" } }]
    const plain: Prompt = [{ type: "text", content: "/brainstorming ", start: 0, end: 15 }]
    expect(isPromptEqual(marked, plain)).toBe(false)
  })

  test("two marked TextParts with different command.name are NOT equal", () => {
    const a: Prompt = [{ type: "text", content: "/a ", start: 0, end: 3,
      command: { name: "a", source: "skill", icon: "command" } }]
    const b: Prompt = [{ type: "text", content: "/a ", start: 0, end: 3,
      command: { name: "b", source: "skill", icon: "command" } }]
    expect(isPromptEqual(a, b)).toBe(false)
  })
})

describe("isPartEqual with attachment parts", () => {
  const chip = (overrides?: Partial<AttachmentPart>): AttachmentPart => ({
    type: "attachment",
    id: "att_1",
    path: "/Users/me/shot.png",
    filename: "shot.png",
    mime: "image/png",
    ...overrides,
  })

  test("two attachment parts with same id+path are equal", () => {
    expect(isPromptEqual([chip()], [chip()])).toBe(true)
  })

  test("attachment parts with different paths are NOT equal", () => {
    expect(isPromptEqual([chip()], [chip({ path: "/Users/me/other.png" })])).toBe(false)
  })

  test("attachment vs image part are NOT equal", () => {
    const image: ImageAttachmentPart = { type: "image", id: "att_1", filename: "shot.png", mime: "image/png", dataUrl: "data:" }
    expect(isPromptEqual([chip()], [image])).toBe(false)
  })
})

describe("isStructurallyEmpty", () => {
  test("DEFAULT_PROMPT + no context + no images → true", () => {
    expect(isStructurallyEmpty(DEFAULT_PROMPT, [], [])).toBe(true)
  })
  test("whitespace-only text → false", () => {
    const p: Prompt = [{ type: "text", content: "   ", start: 0, end: 3 }]
    expect(isStructurallyEmpty(p, [], [])).toBe(false)
  })
  test("attachments present → false", () => {
    const file = { type: "file" as const, content: "@foo.ts", start: 0, end: 7, path: "foo.ts" }
    expect(isStructurallyEmpty([file], [], [])).toBe(false)
  })
  test("context items present → false", () => {
    const ctx: ContextItem[] = [{ type: "file", path: "foo.ts" }]
    expect(isStructurallyEmpty(DEFAULT_PROMPT, ctx, [])).toBe(false)
  })
  test("image attachments present → false", () => {
    const image: ImageAttachmentPart = { type: "image", id: "1", filename: "a.png", mime: "image/png", dataUrl: "data:" }
    expect(isStructurallyEmpty(DEFAULT_PROMPT, [], [image])).toBe(false)
  })
  test("attachment chips present → false", () => {
    const chip: AttachmentPart = { type: "attachment", id: "1", path: "/a/b.pdf", filename: "b.pdf" }
    expect(isStructurallyEmpty(DEFAULT_PROMPT, [], [chip])).toBe(false)
  })
})
