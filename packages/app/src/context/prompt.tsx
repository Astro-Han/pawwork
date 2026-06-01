import { createSimpleContext } from "@opencode-ai/ui/context"
import { checksum } from "@opencode-ai/util/encode"
import type { ResolvedMention } from "@/components/prompt-input/mention-metadata"
import { useParams } from "@solidjs/router"
import { batch, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { FileSelection } from "@/context/file"
import { Persist, persisted } from "@/utils/persist"

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
  selection?: FileSelection
}

export interface AgentPart extends PartBase {
  type: "agent"
  name: string
}

export interface ImageAttachmentPart {
  type: "image"
  id: string
  filename: string
  mime: string
  dataUrl: string
}

export type ContentPart = TextPart | FileAttachmentPart | AgentPart | ImageAttachmentPart
export type Prompt = ContentPart[]

export type FileContextItem = {
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
  /** Resolved mention metadata captured at the moment the comment text was committed */
  resolvedMentions?: ResolvedMention[]
}

export type ContextItem = FileContextItem

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

function isCommandMetaEqual(a: TextPart["command"], b: TextPart["command"]) {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.name === b.name && a.source === b.source && a.icon === b.icon
}

function isPartEqual(partA: ContentPart, partB: ContentPart) {
  switch (partA.type) {
    case "text":
      return (
        partB.type === "text" &&
        partA.content === partB.content &&
        isCommandMetaEqual(partA.command, partB.command)
      )
    case "file":
      return partB.type === "file" && partA.path === partB.path && isSelectionEqual(partA.selection, partB.selection)
    case "agent":
      return partB.type === "agent" && partA.name === partB.name
    case "image":
      return partB.type === "image" && partA.id === partB.id
  }
}

export function isPromptEqual(promptA: Prompt, promptB: Prompt): boolean {
  if (promptA.length !== promptB.length) return false
  for (let i = 0; i < promptA.length; i++) {
    if (!isPartEqual(promptA[i], promptB[i])) return false
  }
  return true
}

export function isStructurallyEmpty(
  prompt: Prompt,
  contextItems: readonly ContextItem[],
  imageAttachments: readonly ImageAttachmentPart[],
): boolean {
  if (contextItems.length > 0) return false
  if (imageAttachments.length > 0) return false
  return isPromptEqual(prompt, DEFAULT_PROMPT)
}

function cloneSelection(selection?: FileSelection) {
  if (!selection) return undefined
  return { ...selection }
}

function clonePart(part: ContentPart): ContentPart {
  if (part.type === "text") return { ...part }
  if (part.type === "image") return { ...part }
  if (part.type === "agent") return { ...part }
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
    /** Atomic full-replace: swaps ALL context items at once. Used by carry hydration and failure restore. */
    replaceAll: (items: ContextItem[]) => void
  }
  set: (prompt: Prompt, cursorPosition?: number) => void
  reset: () => void
}

export function createPromptBinding(
  scope: () => Scope | undefined,
  load: (dir: string, id: string | undefined) => PromptBindingSession,
) {
  const session = () => {
    const current = scope()
    if (!current) return
    return load(current.dir, current.id)
  }
  const pick = (target?: Scope) => (target ? load(target.dir, target.id) : session())

  return {
    ready: () => session()?.ready() ?? false,
    current: () => session()?.current() ?? clonePrompt(DEFAULT_PROMPT),
    cursor: () => session()?.cursor(),
    dirty: () => session()?.dirty() ?? false,
    hasDraft: (target?: Scope) => pick(target)?.hasDraft() ?? false,
    context: {
      items: () => session()?.context.items() ?? [],
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

  const [store, setStore, _, ready] = persisted(
    Persist.scoped(dir, id, "prompt", [legacy]),
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
        // Atomic full-replace used by carry hydration (portable snapshot).
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
