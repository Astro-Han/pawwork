import { selectionFromLines, type FileSelection, type SelectedLineRange } from "@/context/file/types"
import { previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { captureCommentMentions, type ResolvedMention } from "@/components/prompt-input/mention-metadata"

export function createSessionCommentContext(input: {
  attachmentLabel: () => string
  getFileContent: (path: string) => string | undefined
  /**
   * Filesystem directory the comment is being authored from. Required so that
   * @mention paths captured at comment-create time resolve against the source
   * workspace and survive a homepage move to a different workspace.
   */
  sourceFilesystemDirectory: () => string
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
      resolvedMentions?: ResolvedMention[]
    }) => void
    updateComment: (
      file: string,
      id: string,
      patch: { comment: string; preview?: string; resolvedMentions?: ResolvedMention[] },
    ) => void
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
      const resolvedMentions = captureCommentMentions({
        comment: comment.comment,
        sourceFilesystemDirectory: input.sourceFilesystemDirectory(),
      })
      input.promptContext.add({
        type: "file",
        path: comment.file,
        selection,
        comment: comment.comment,
        commentID: saved.id,
        commentOrigin: comment.origin,
        preview,
        resolvedMentions,
      })
    },
    update(comment: { id: string; file: string; selection: SelectedLineRange; comment: string; preview?: string }) {
      input.comments.update(comment.file, comment.id, comment.comment)
      const resolvedMentions = captureCommentMentions({
        comment: comment.comment,
        sourceFilesystemDirectory: input.sourceFilesystemDirectory(),
      })
      input.promptContext.updateComment(comment.file, comment.id, {
        comment: comment.comment,
        resolvedMentions,
        ...(comment.preview !== undefined ? { preview: comment.preview } : {}),
      })
    },
    remove(comment: { id: string; file: string }) {
      input.comments.remove(comment.file, comment.id)
      input.promptContext.removeComment(comment.file, comment.id)
    },
  }
}
