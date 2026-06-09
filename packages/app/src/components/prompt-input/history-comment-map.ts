import type { ContextItem } from "@/context/prompt"
import { selectionFromLines } from "@/context/file"
import type { PromptHistoryComment } from "./history"

/**
 * Build the comment lookup map used by historyComments().
 *
 * Lives in its own module so the unit test can import it without pulling the
 * full history-navigation graph (useSDK / Solid router).
 */
export function buildCommentByIDMap<T extends { file: string; id: string }>(
  comments: T[],
): Map<string, T> {
  return new Map(comments.map((item) => [`${item.file}\n${item.id}`, item] as const))
}

export function buildPromptHistoryComments<
  T extends { file: string; id: string; selection: { start: number; end: number }; time: number },
>(
  items: (ContextItem & { key: string })[],
  comments: T[],
): PromptHistoryComment[] {
  const byID = buildCommentByIDMap(comments)

  return items.flatMap((item) => {
    if (item.type !== "file") return []
    const comment = item.comment?.trim()
    if (!comment) return []

    const commentPath = item.commentPath ?? item.path
    const storedComment = item.commentID ? byID.get(`${commentPath}\n${item.commentID}`) : undefined
    const selection =
      storedComment?.selection ??
      (item.selection
        ? {
            start: item.selection.startLine,
            end: item.selection.endLine,
          }
        : undefined)
    if (!selection) return []

    return [
      {
        id: item.commentID ?? item.key,
        path: item.path,
        commentPath: item.commentPath,
        selection: { ...selection },
        comment,
        time: storedComment?.time ?? Date.now(),
        origin: item.commentOrigin,
        preview: item.preview,
        resolvedMentions: item.resolvedMentions,
      } satisfies PromptHistoryComment,
    ]
  })
}

export function buildPromptHistoryCommentRestore(items: PromptHistoryComment[]) {
  return {
    comments: items.map((item) => ({
      id: item.id,
      file: item.commentPath ?? item.path,
      selection: { ...item.selection },
      comment: item.comment,
      time: item.time,
    })),
    context: items.map((item) => ({
      type: "file" as const,
      path: item.path,
      commentPath: item.commentPath,
      selection: selectionFromLines(item.selection),
      comment: item.comment,
      commentID: item.id,
      commentOrigin: item.origin,
      preview: item.preview,
      resolvedMentions: item.resolvedMentions,
    })),
  }
}
