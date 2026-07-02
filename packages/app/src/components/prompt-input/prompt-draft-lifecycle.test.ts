import { describe, expect, test } from "bun:test"
import type { ContextItem, Prompt, usePrompt } from "@/context/prompt"
import type { PromptRouteScope } from "@/pages/session/prompt-route-scope"
import type { usePinnedDraft } from "./pinned-draft"
import { createPromptDraftLifecycle } from "./prompt-draft-lifecycle"

function promptLength(prompt: Prompt) {
  return prompt.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0)
}

function createLifecycleInput(input: {
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  submittedContext: (ContextItem & { key: string })[]
  commentItems: (ContextItem & { key: string })[]
  scope: PromptRouteScope
  resetCalls: PromptRouteScope[]
}) {
  let liveContext = input.context.slice()
  const prompt = {
    current: () => input.prompt,
    hasDraft: () => false,
    set: () => undefined,
    reset: (target?: PromptRouteScope) => {
      if (target) input.resetCalls.push(target)
    },
    context: {
      items: () => liveContext,
      remove: (key: string) => {
        liveContext = liveContext.filter((item) => item.key !== key)
      },
      replaceAll: () => undefined,
    },
  } as unknown as ReturnType<typeof usePrompt>

  return {
    prompt,
    pinned: { clearAll: () => true } as unknown as ReturnType<typeof usePinnedDraft>,
    params: () => input.scope,
    ownership: { kind: "route" as const, scope: input.scope },
    sourcePromptScope: input.scope,
    promptScope: input.scope,
    mode: "normal" as const,
    currentPrompt: input.prompt,
    submittedDraft: { prompt: input.prompt, context: input.submittedContext },
    commentItems: input.commentItems,
    editor: () => undefined,
    promptLength,
    queueScroll: () => undefined,
    setMode: () => undefined,
    setPopover: () => undefined,
  }
}

describe("createPromptDraftLifecycle", () => {
  test("clears a route draft after submitted comment context is stripped", () => {
    const scope = { dir: "/repo/main", id: "session-1" }
    const prompt: Prompt = [{ type: "text", content: "summarize this", start: 0, end: 14 }]
    const plainItem = { key: "plain", type: "file" as const, path: "/repo/main/src/a.ts" }
    const commentItem = {
      key: "comment",
      type: "file" as const,
      path: "/repo/main/src/b.ts",
      comment: "important bit",
      commentID: "comment-1",
    }
    const resetCalls: PromptRouteScope[] = []
    const lifecycle = createPromptDraftLifecycle(
      createLifecycleInput({
        prompt,
        context: [plainItem, commentItem],
        submittedContext: [plainItem, commentItem],
        commentItems: [commentItem],
        scope,
        resetCalls,
      }),
    )

    lifecycle.removeSubmittedCommentItems()
    lifecycle.clearInput()

    expect(resetCalls).toEqual([scope])
  })
})
