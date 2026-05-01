import { selectionFromLines, type FileSelection, type SelectedLineRange } from "@/context/file/types"
import { previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"

export function createSessionCommentContext(input: {
  attachmentLabel: () => string
  getFileContent: (path: string) => string | undefined
  comments: {
    add: (comment: { file: string; selection: SelectedLineRange; comment: string }) => { id: string }
    update: (file: string, id: string, comment: string) => void
    remove: (file: string, id: string) => void
  }
  promptContext: {
    add: (entry: {
      type: "file"
      path: string
      selection: FileSelection
      comment: string
      commentID: string
      commentOrigin?: "review" | "file"
      preview?: string
    }) => void
    updateComment: (file: string, id: string, patch: { comment: string; preview?: string }) => void
    removeComment: (file: string, id: string) => void
  }
}) {
  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = input.getFileContent(path)
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  return {
    add(comment: {
      file: string
      selection: SelectedLineRange
      comment: string
      preview?: string
      origin?: "review" | "file"
    }) {
      const selection = selectionFromLines(comment.selection)
      const preview = comment.preview ?? selectionPreview(comment.file, selection)
      const saved = input.comments.add({
        file: comment.file,
        selection: comment.selection,
        comment: comment.comment,
      })
      input.promptContext.add({
        type: "file",
        path: comment.file,
        selection,
        comment: comment.comment,
        commentID: saved.id,
        commentOrigin: comment.origin,
        preview,
      })
    },
    update(comment: { id: string; file: string; selection: SelectedLineRange; comment: string; preview?: string }) {
      input.comments.update(comment.file, comment.id, comment.comment)
      input.promptContext.updateComment(comment.file, comment.id, {
        comment: comment.comment,
        ...(comment.preview !== undefined ? { preview: comment.preview } : {}),
      })
    },
    remove(comment: { id: string; file: string }) {
      input.comments.remove(comment.file, comment.id)
      input.promptContext.removeComment(comment.file, comment.id)
    },
  }
}
