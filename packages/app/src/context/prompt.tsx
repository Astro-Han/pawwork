import { createSimpleContext } from "@opencode-ai/ui/context"
import { checksum } from "@opencode-ai/util/encode"
import type { ResolvedMention } from "@/components/prompt-input/mention-metadata"
import { useParams } from "@solidjs/router"
import { batch, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { FileSelection } from "@/context/file"
import { Persist, persisted } from "@/utils/persist"
import { DEFAULT_PROMPT, isPromptEqual, isStructurallyEmpty } from "./prompt-equality"

export { DEFAULT_PROMPT, isPromptEqual, isStructurallyEmpty }

interface PartBase {
  content: string
  start: number
  end: number
}

export type CommandSource = "skill" | "mcp" | "command"

export interface TextPart extends PartBase {
  type: "text"
  command?: {
    name: string
    source: CommandSource
    icon: string
  }
}

export interface FileAttachmentPart extends PartBase {
  type: "file"
  path: string
  size?: number
  selection?: FileSelection
}

export interface AgentPart extends PartBase {
  type: "agent"
  name: string
}

// Inline skill chip: a structured, position-independent reference (mirrors AgentPart).
// `name` is the command/skill name; `source` drives the chip badge/icon. On send it
// becomes a SkillPartInput; the server expands the template into model-visible text.
export interface SkillAttachmentPart extends PartBase {
  type: "skill"
  name: string
  source: CommandSource
}

export interface ImageAttachmentPart {
  type: "image"
  id: string
  filename: string
  mime: string
  dataUrl: string
}

// Floating path-backed attachment chip: lives in the prompt array but never in
// the editor text (mirrors ImageAttachmentPart conservation). Created by the
// entry-point attachment pipeline (picker / drop / paste); typed `@` references
// remain inline FileAttachmentPart pills.
export interface AttachmentPart {
  type: "attachment"
  id: string
  path: string
  filename: string
  /** Best-effort mime derived from the path suffix; drives image-chip rendering. */
  mime?: string
  size?: number
}

/** Parts that float outside the editor text and render as composer chips. */
export type FloatingAttachment = ImageAttachmentPart | AttachmentPart

export const isFloatingAttachment = (part: ContentPart): part is FloatingAttachment =>
  part.type === "image" || part.type === "attachment"

export type ContentPart =
  | TextPart
  | FileAttachmentPart
  | AgentPart
  | SkillAttachmentPart
  | ImageAttachmentPart
  | AttachmentPart
export type Prompt = ContentPart[]

export type FileContextItem = {
  type: "file"
  /** File path used for model/file attachment resolution. May be absolute across workspace switches. */
  path: string
  /** Path key used by the comments store and file UI. Usually workspace-relative. */
  commentPath?: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
  /** Resolved mention metadata captured at the moment the comment text was committed */
  resolvedMentions?: ResolvedMention[]
}

export type ContextItem = FileContextItem

function cloneSelection(selection?: FileSelection) {
  if (!selection) return undefined
  return { ...selection }
}

function clonePart(part: ContentPart): ContentPart {
  if (part.type === "text") return { ...part }
  if (part.type === "image") return { ...part }
  if (part.type === "attachment") return { ...part }
  if (part.type === "agent") return { ...part }
  if (part.type === "skill") return { ...part }
  return {
    ...part,
    selection: cloneSelection(part.selection),
  }
}

function clonePrompt(prompt: Prompt): Prompt {
  return prompt.map(clonePart)
}

function contextItemKey(item: ContextItem) {
  if (item.type !== "file") return item.type
  const start = item.selection?.startLine
  const end = item.selection?.endLine
  const key = `${item.type}:${item.path}:${start}:${end}`

  if (item.commentID) {
    return `${key}:c=${item.commentID}`
  }

  const comment = item.comment?.trim()
  if (!comment) return key
  const digest = checksum(comment) ?? comment
  return `${key}:c=${digest.slice(0, 8)}`
}

function isCommentItem(item: ContextItem | (ContextItem & { key: string })) {
  return item.type === "file" && !!item.comment?.trim()
}

function createPromptActions(
  setStore: SetStoreFunction<{
    prompt: Prompt
    cursor?: number
    context: {
      items: (ContextItem & { key: string })[]
    }
  }>,
) {
  return {
    set(prompt: Prompt, cursorPosition?: number) {
      const next = clonePrompt(prompt)
      batch(() => {
        setStore("prompt", next)
        if (cursorPosition !== undefined) setStore("cursor", cursorPosition)
      })
    },
    reset() {
      batch(() => {
        setStore("prompt", clonePrompt(DEFAULT_PROMPT))
        setStore("cursor", 0)
      })
    },
  }
}

const WORKSPACE_KEY = "__workspace__"
export const GLOBAL_HOMEPAGE_PROMPT_STORAGE_KEY = "prompt-homepage"
const GLOBAL_HOMEPAGE_PROMPT_DIR = "__homepage__"
const MAX_PROMPT_SESSIONS = 20

type PromptSession = ReturnType<typeof createPromptSession>

type Scope = {
  dir: string
  id?: string
}

type PromptCacheEntry = {
  value: PromptSession
  dispose: VoidFunction
}

type PromptBindingSession = {
  ready: () => boolean
  current: () => Prompt
  cursor: () => number | undefined
  dirty: () => boolean
  hasDraft: () => boolean
  context: {
    items: () => (ContextItem & { key: string })[]
    add: (item: ContextItem) => void
    remove: (key: string) => void
    removeComment: (path: string, commentID: string) => void
    updateComment: (path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) => void
    replaceComments: (items: FileContextItem[]) => void
    /** Atomic full-replace: swaps ALL context items at once. Used by migration hydration and failure restore. */
    replaceAll: (items: ContextItem[]) => void
  }
  set: (prompt: Prompt, cursorPosition?: number) => void
  reset: () => void
}

export function createPromptBinding(
  scope: () => Scope | undefined,
  load: (dir: string, id: string | undefined) => PromptBindingSession,
) {
  const loadScope = (current: Scope): Scope => {
    if (current.id) return current
    return { dir: GLOBAL_HOMEPAGE_PROMPT_DIR }
  }
  const session = () => {
    const current = scope()
    if (!current) return
    const normalized = loadScope(current)
    return load(normalized.dir, normalized.id)
  }
  const pick = (target?: Scope) => {
    if (!target) return session()
    const normalized = loadScope(target)
    return load(normalized.dir, normalized.id)
  }

  return {
    ready: () => session()?.ready() ?? false,
    current: (target?: Scope) => pick(target)?.current() ?? clonePrompt(DEFAULT_PROMPT),
    cursor: () => session()?.cursor(),
    dirty: () => session()?.dirty() ?? false,
    hasDraft: (target?: Scope) => pick(target)?.hasDraft() ?? false,
    context: {
      items: (target?: Scope) => pick(target)?.context.items() ?? [],
      add: (item: ContextItem) => session()?.context.add(item),
      remove: (key: string) => session()?.context.remove(key),
      removeComment: (path: string, commentID: string) => session()?.context.removeComment(path, commentID),
      updateComment: (path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) =>
        session()?.context.updateComment(path, commentID, next),
      replaceComments: (items: FileContextItem[]) => session()?.context.replaceComments(items),
      replaceAll: (items: ContextItem[], target?: Scope) => pick(target)?.context.replaceAll(items),
    },
    set: (prompt: Prompt, cursorPosition?: number, target?: Scope) => pick(target)?.set(prompt, cursorPosition),
    reset: (target?: Scope) => pick(target)?.reset(),
  }
}

function createPromptSession(dir: string, id: string | undefined) {
  const legacy = `${dir}/prompt${id ? "/" + id : ""}.v2`
  const target =
    !id && dir === GLOBAL_HOMEPAGE_PROMPT_DIR
      ? Persist.global(GLOBAL_HOMEPAGE_PROMPT_STORAGE_KEY)
      : Persist.scoped(dir, id, "prompt", [legacy])

  const [store, setStore, _, ready] = persisted(
    target,
    createStore<{
      prompt: Prompt
      cursor?: number
      context: {
        items: (ContextItem & { key: string })[]
      }
    }>({
      prompt: clonePrompt(DEFAULT_PROMPT),
      cursor: undefined,
      context: {
        items: [],
      },
    }),
  )

  const actions = createPromptActions(setStore)

  return {
    ready,
    current: createMemo(() => store.prompt),
    cursor: createMemo(() => store.cursor),
    dirty: createMemo(() => !isPromptEqual(store.prompt, DEFAULT_PROMPT)),
    hasDraft: createMemo(() => !isStructurallyEmpty(store.prompt, store.context.items, [])),
    context: {
      items: createMemo(() => store.context.items),
      add(item: ContextItem) {
        const key = contextItemKey(item)
        if (store.context.items.find((x) => x.key === key)) return
        setStore("context", "items", (items) => [...items, { key, ...item }])
      },
      remove(key: string) {
        setStore("context", "items", (items) => items.filter((x) => x.key !== key))
      },
      removeComment(path: string, commentID: string) {
        setStore("context", "items", (items) =>
          items.filter((item) => !(item.type === "file" && item.path === path && item.commentID === commentID)),
        )
      },
      updateComment(path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) {
        setStore("context", "items", (items) =>
          items.map((item) => {
            if (item.type !== "file" || item.path !== path || item.commentID !== commentID) return item
            const value = { ...item, ...next }
            return { ...value, key: contextItemKey(value) }
          }),
        )
      },
      replaceComments(items: FileContextItem[]) {
        setStore("context", "items", (current) => [
          ...current.filter((item) => !isCommentItem(item)),
          ...items.map((item) => ({ ...item, key: contextItemKey(item) })),
        ])
      },
      replaceAll(items: ContextItem[]) {
        // Atomic full-replace used by migration hydration and failure restore.
        // Regenerates keys so snapshot keys do not collide with the target route.
        setStore("context", "items", items.map((item) => ({ ...item, key: contextItemKey(item) })))
      },
    },
    set: actions.set,
    reset: actions.reset,
  }
}

export const { use: usePrompt, provider: PromptProvider } = createSimpleContext({
  name: "Prompt",
  gate: false,
  init: () => {
    const params = useParams()
    const cache = new Map<string, PromptCacheEntry>()

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_PROMPT_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const owner = getOwner()
    const load = (dir: string, id: string | undefined) => {
      const key = `${dir}:${id ?? WORKSPACE_KEY}`
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot(
        (dispose) => ({
          value: createPromptSession(dir, id),
          dispose,
        }),
        owner,
      )

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const scope = createMemo<Scope | undefined>(() => (params.dir ? { dir: params.dir, id: params.id } : undefined))
    return createPromptBinding(scope, load)
  },
})
