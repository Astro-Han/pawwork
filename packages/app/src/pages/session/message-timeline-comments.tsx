import { createMemo, For, Index, Show } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { getFilename } from "@opencode-ai/util/path"
import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"

/**
 * Slice 11b.1: message comment rendering extracted from
 * `message-timeline.tsx` per design doc §3b.
 *
 * Inline comments are synthetic text parts whose metadata carries a
 * file path + selection range. The list rail above each turn renders
 * them as small file chips so the user can see what they're
 * commenting on at a glance.
 *
 *   `MessageComment` — type-only contract for a parsed comment.
 *   `messageComments(parts)` — pure parser: synthesizes a flat list
 *                              from a message's parts.
 *   `MessageCommentList` — JSX renderer for a single message's chips.
 */

export type MessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

export function messageComments(parts: Part[]): MessageComment[] {
  return parts.flatMap((part) => {
    if (part.type !== "text" || !(part as TextPart).synthetic) return []
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return []
    return [
      {
        path: next.path,
        comment: next.comment,
        selection: next.selection
          ? {
              startLine: next.selection.startLine,
              endLine: next.selection.endLine,
            }
          : undefined,
      },
    ]
  })
}

export function MessageCommentList(props: { comments: MessageComment[] }) {
  return (
    <Show when={props.comments.length > 0}>
      <div class="w-full px-4 md:px-5 pb-2">
        <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
          <div class="flex w-max min-w-full justify-end gap-2">
            <Index each={props.comments}>
              {(commentAccessor: () => MessageComment) => {
                const comment = createMemo(() => commentAccessor())
                return (
                  <Show when={comment()}>
                    {(c) => (
                      <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak bg-bg-base px-2.5 py-2">
                        <div class="flex items-center gap-1.5 min-w-0 text-13-medium text-fg-strong">
                          <FileIcon node={{ path: c().path, type: "file" }} class="size-3.5 shrink-0" />
                          <span class="truncate">{getFilename(c().path)}</span>
                          <Show when={c().selection}>
                            {(selection) => (
                              <span class="shrink-0 text-fg-weak">
                                {selection().startLine === selection().endLine
                                  ? `:${selection().startLine}`
                                  : `:${selection().startLine}-${selection().endLine}`}
                              </span>
                            )}
                          </Show>
                        </div>
                        <div class="pt-1 text-13-regular text-fg-strong whitespace-pre-wrap break-words">
                          {c().comment}
                        </div>
                      </div>
                    )}
                  </Show>
                )
              }}
            </Index>
          </div>
        </div>
      </div>
    </Show>
  )
}
