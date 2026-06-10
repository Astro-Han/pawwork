import { getFilename } from "@opencode-ai/util/path"
import {
  type AgentPartInput,
  type FilePartInput,
  type Part,
  type SkillPartInput,
  type TextPartInput,
} from "@opencode-ai/sdk/v2/client"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type { AgentPart, FileAttachmentPart, ImageAttachmentPart, Prompt, SkillAttachmentPart } from "@/context/prompt"
import { Identifier } from "@/utils/id"
import { createCommentMetadata, formatCommentNote } from "@/utils/comment-note"
import { toAbsoluteFilePath } from "./path-canonical"
import type { ResolvedMention } from "./mention-metadata"
import { resolveCommentMentions } from "./mention-metadata"

type PromptRequestPart = (TextPartInput | FilePartInput | AgentPartInput | SkillPartInput) & { id: string }

type ContextFile = {
  key: string
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
  resolvedMentions?: ResolvedMention[]
}

type BuildRequestPartsInput = {
  prompt: Prompt
  context: ContextFile[]
  images: ImageAttachmentPart[]
  text: string
  messageID: string
  sessionID: string
  sessionDirectory: string
}

const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""

const fileURL = (path: string, selection?: FileSelection) => {
  const encoded = encodeFilePath(path)
  const body = path.startsWith("\\\\") || path.startsWith("//") ? encoded.replace(/^\/+/, "") : encoded
  return `file://${body}${fileQuery(selection)}`
}

const isFileAttachment = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"
const isAgentAttachment = (part: Prompt[number]): part is AgentPart => part.type === "agent"
const isSkillAttachment = (part: Prompt[number]): part is SkillAttachmentPart => part.type === "skill"

function buildPromptFileParts(prompt: Prompt, sessionDirectory: string) {
  return prompt.filter(isFileAttachment).map((attachment) => {
    const path = toAbsoluteFilePath(sessionDirectory, attachment.path)
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url: fileURL(path, attachment.selection),
      filename: getFilename(attachment.path),
      source: {
        type: "file",
        text: {
          value: attachment.content,
          start: attachment.start,
          end: attachment.end,
        },
        path,
      },
    } satisfies PromptRequestPart
  })
}

function buildLegacyImageParts(images: ImageAttachmentPart[]) {
  return images.map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: attachment.mime,
      url: attachment.dataUrl,
      filename: attachment.filename,
    } satisfies PromptRequestPart
  })
}

export function buildAttachmentRequestParts(input: {
  prompt: Prompt
  images: ImageAttachmentPart[]
  sessionDirectory: string
}) {
  return [...buildPromptFileParts(input.prompt, input.sessionDirectory), ...buildLegacyImageParts(input.images)]
}

const toOptimisticPart = (part: PromptRequestPart, sessionID: string, messageID: string): Part => {
  if (part.type === "text") {
    return {
      id: part.id,
      type: "text",
      text: part.text,
      synthetic: part.synthetic,
      ignored: part.ignored,
      time: part.time,
      metadata: part.metadata,
      sessionID,
      messageID,
    }
  }
  if (part.type === "file") {
    return {
      id: part.id,
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source,
      sessionID,
      messageID,
    }
  }
  // Skill must be handled before the agent fallthrough: the optimistic chip has
  // to match the server-persisted structured SkillPart so the bubble does not
  // flicker when the real message arrives.
  if (part.type === "skill") {
    return {
      id: part.id,
      type: "skill",
      name: part.name,
      source: part.source,
      sessionID,
      messageID,
    }
  }
  return {
    id: part.id,
    type: "agent",
    name: part.name,
    source: part.source,
    sessionID,
    messageID,
  }
}

export function buildRequestParts(input: BuildRequestPartsInput) {
  const requestParts: PromptRequestPart[] = [
    {
      id: Identifier.ascending("part"),
      type: "text",
      text: input.text,
    },
  ]

  const files = buildPromptFileParts(input.prompt, input.sessionDirectory)

  const agents = input.prompt.filter(isAgentAttachment).map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "agent",
      name: attachment.name,
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    } satisfies PromptRequestPart
  })

  const skills = input.prompt.filter(isSkillAttachment).map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "skill",
      name: attachment.name,
      // source.{value,start,end} marks the "/name" span in the flattened text so
      // the sent bubble can render it as a chip; the server expands the template.
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    } satisfies PromptRequestPart
  })

  const used = new Set(files.map((part) => part.url))
  const context = input.context.flatMap((item) => {
    const path = toAbsoluteFilePath(input.sessionDirectory, item.path)
    const url = fileURL(path, item.selection)
    const comment = item.comment?.trim()
    if (!comment && used.has(url)) return []
    used.add(url)

    const filePart = {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url,
      filename: getFilename(item.path),
    } satisfies PromptRequestPart

    if (!comment) return [filePart]

    // resolveCommentMentions returns [] when resolvedMentions is undefined —
    // free-text @mentions without metadata are intentionally dropped.
    const mentions = resolveCommentMentions({
      comment,
      metadata: item.resolvedMentions,
    }).flatMap((match) => {
      const url = fileURL(match.resolvedPath)
      if (used.has(url)) return []
      used.add(url)
      return [
        {
          id: Identifier.ascending("part"),
          type: "file",
          mime: "text/plain",
          url,
          filename: getFilename(match.resolvedPath),
        } satisfies PromptRequestPart,
      ]
    })

    return [
      {
        id: Identifier.ascending("part"),
        type: "text",
        text: formatCommentNote({ path: item.path, selection: item.selection, comment }),
        synthetic: true,
        metadata: createCommentMetadata({
          path: item.path,
          selection: item.selection,
          comment,
          preview: item.preview,
          origin: item.commentOrigin,
        }),
      } satisfies PromptRequestPart,
      filePart,
      ...mentions,
    ]
  })

  const images = buildLegacyImageParts(input.images)

  requestParts.push(...files, ...context, ...agents, ...skills, ...images)

  return {
    requestParts,
    optimisticParts: requestParts.map((part) => toOptimisticPart(part, input.sessionID, input.messageID)),
  }
}
