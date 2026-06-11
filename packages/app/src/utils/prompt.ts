import type { FilePart, Part, SkillPart, TextPart } from "@opencode-ai/sdk/v2"
import { deriveCommandInvocation } from "@opencode-ai/ui/lib/command-invocation"
import { pathBasename } from "@opencode-ai/util/file-extensions"
import { attachmentMimeForPath } from "@/components/prompt-input/attachment-chips-model"
import { createCommandTextPart } from "@/components/prompt-input/command-text-part"
import { fileUrlToPath } from "@/context/file/path"
import type {
  AttachmentPart,
  FileAttachmentPart,
  ImageAttachmentPart,
  Prompt,
  SkillAttachmentPart,
} from "@/context/prompt"

type Inline =
  | {
      type: "file"
      start: number
      end: number
      value: string
      path: string
      selection?: {
        startLine: number
        endLine: number
        startChar: number
        endChar: number
      }
    }
  | {
      type: "agent"
      start: number
      end: number
      value: string
      name: string
    }
  | {
      type: "skill"
      start: number
      end: number
      value: string
      name: string
    }

function selectionFromFileUrl(url: string): Extract<Inline, { type: "file" }>["selection"] {
  const queryIndex = url.indexOf("?")
  if (queryIndex === -1) return undefined
  const params = new URLSearchParams(url.slice(queryIndex + 1))
  const startLine = Number(params.get("start"))
  const endLine = Number(params.get("end"))
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}

/**
 * Rebuild a floating attachment chip from a path-backed file part: no inline
 * source span, non-data URL. Chips, context items, and comment mentions all
 * submit in this shape; restoring them as chips keeps the file visible in the
 * composer instead of silently dropping it (the wire format cannot tell them
 * apart). Size is unknown after the round-trip and stays unset.
 */
function attachmentFromFilePart(filePart: FilePart): AttachmentPart | undefined {
  // A ?start=&end= query means a line-scoped context reference; a path-only
  // chip would widen it to the whole file on resubmit, so drop it instead.
  if (selectionFromFileUrl(filePart.url)) return undefined
  const path = fileUrlToPath(filePart.url)
  if (!path) return undefined
  return {
    type: "attachment",
    id: filePart.id,
    path,
    filename: filePart.filename ?? pathBasename(path),
    mime: attachmentMimeForPath(path),
  }
}

function textPartValue(parts: Part[]) {
  const candidates = parts
    .filter((part): part is TextPart => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)
  return candidates.reduce((best: TextPart | undefined, part) => {
    if (!best) return part
    if (part.text.length > best.text.length) return part
    return best
  }, undefined)
}

/**
 * Extract prompt content from message parts for restoring into the prompt input.
 * This is used by undo to restore the original user prompt.
 */
export function extractPromptFromParts(parts: Part[], opts?: { directory?: string; attachmentName?: string }): Prompt {
  const attachmentName = opts?.attachmentName ?? "attachment"
  const invocation = deriveCommandInvocation(parts)
  if (invocation) {
    // Restore as a marked TextPart so the editor can re-render it as a pill.
    const commandPart = createCommandTextPart(
      { name: invocation.name, source: invocation.source, icon: invocation.markIcon },
      invocation.args,
    )
    const out: Prompt = [commandPart]
    for (const part of parts) {
      if (part.type !== "file") continue
      const filePart = part as FilePart
      if (invocation.suppressFilePartIds.includes(filePart.id)) continue
      // Inline `@file` pills inside the command args submit with source.text.
      // The mention text survives inside the restored args, and the engine
      // re-derives a file part from it on every command submit
      // (resolvePromptParts), so a chip here would duplicate the reference.
      if (filePart.source?.text) continue
      if (filePart.url.startsWith("data:")) {
        const image: ImageAttachmentPart = {
          type: "image",
          id: filePart.id,
          filename: filePart.filename ?? attachmentName,
          mime: filePart.mime,
          dataUrl: filePart.url,
        }
        out.push(image)
        continue
      }
      const chip = attachmentFromFilePart(filePart)
      if (chip) out.push(chip)
    }
    return out
  }

  const textPart = textPartValue(parts)
  const text = textPart?.text ?? ""
  const directory = opts?.directory

  const toRelative = (path: string) => {
    if (!directory) return path

    const prefix = directory.endsWith("/") ? directory : directory + "/"
    if (path.startsWith(prefix)) return path.slice(prefix.length)

    if (path.startsWith(directory)) {
      const next = path.slice(directory.length)
      if (next.startsWith("/")) return next.slice(1)
      return next
    }

    return path
  }

  const inline: Inline[] = []
  const floating: (ImageAttachmentPart | AttachmentPart)[] = []

  for (const part of parts) {
    if (part.type === "file") {
      const filePart = part as FilePart
      const sourceText = filePart.source?.text
      if (sourceText) {
        const value = sourceText.value
        const start = sourceText.start
        const end = sourceText.end
        let path = value
        if (value.startsWith("@")) path = value.slice(1)
        if (!value.startsWith("@") && filePart.source && "path" in filePart.source) {
          path = filePart.source.path
        }
        inline.push({
          type: "file",
          start,
          end,
          value,
          path: toRelative(path),
          selection: selectionFromFileUrl(filePart.url),
        })
        continue
      }

      if (filePart.url.startsWith("data:")) {
        floating.push({
          type: "image",
          id: filePart.id,
          filename: filePart.filename ?? attachmentName,
          mime: filePart.mime,
          dataUrl: filePart.url,
        })
        continue
      }

      const chip = attachmentFromFilePart(filePart)
      if (chip) floating.push(chip)
    }

    // PawWork issue #239: AgentPart records from history are intentionally NOT
    // converted to inline agent pills. The original `@<name>` substring is
    // already in the surrounding text part, so it restores as plain text.
    // This single point also defuses buildRequestParts (no AgentPartInput
    // submitted) and renderEditor (no pill).

    // Skills, unlike agents, ARE structured + persisted with a source span and
    // expand server-side, so restore them as inline chips — otherwise fork/undo
    // would resubmit a literal "/name" that no longer expands (and a leading one
    // would reroute to the legacy command endpoint).
    if (part.type === "skill") {
      const skillPart = part as SkillPart
      const source = skillPart.source
      if (source?.value && source.start !== undefined && source.end !== undefined) {
        inline.push({
          type: "skill",
          start: source.start,
          end: source.end,
          value: source.value,
          name: skillPart.name,
        })
      }
    }
  }

  inline.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return a.end - b.end
  })

  const result: Prompt = []
  let position = 0
  let cursor = 0

  const pushText = (content: string) => {
    if (!content) return
    result.push({
      type: "text",
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const pushFile = (item: Extract<Inline, { type: "file" }>) => {
    const content = item.value
    const attachment: FileAttachmentPart = {
      type: "file",
      path: item.path,
      content,
      start: position,
      end: position + content.length,
      selection: item.selection,
    }
    result.push(attachment)
    position += content.length
  }

  const pushSkill = (item: Extract<Inline, { type: "skill" }>) => {
    const content = item.value
    // The persisted SkillPart drops the source kind; default to "skill" (the
    // chip glyph is uniform across sources anyway).
    const attachment: SkillAttachmentPart = {
      type: "skill",
      name: item.name,
      source: "skill",
      content,
      start: position,
      end: position + content.length,
    }
    result.push(attachment)
    position += content.length
  }

  for (const item of inline) {
    if (item.start < 0 || item.end < item.start) continue

    const expected = item.value
    if (!expected) continue

    const mismatch = item.end > text.length || item.start < cursor || text.slice(item.start, item.end) !== expected
    const start = mismatch ? text.indexOf(expected, cursor) : item.start
    if (start === -1) continue
    const end = mismatch ? start + expected.length : item.end

    pushText(text.slice(cursor, start))

    if (item.type === "file") pushFile(item)
    if (item.type === "skill") pushSkill(item)

    cursor = end
  }

  pushText(text.slice(cursor))

  if (result.length === 0) {
    result.push({ type: "text", content: "", start: 0, end: 0 })
  }

  if (floating.length === 0) return result
  return [...result, ...floating]
}

/**
 * One-line list-row preview of a restored prompt (fork dialog, revert banner):
 * inline parts keep their text, floating attachments render as [image:name] /
 * [file:path], and a prompt with no visible text falls back to the localized
 * attachment label so attachment-only messages never show as a blank row.
 */
export function promptPreviewText(prompt: Prompt, attachmentLabel: string): string {
  const text = prompt
    .map((part) => {
      if (part.type === "image") return `[image:${part.filename}]`
      if (part.type === "attachment") return `[file:${part.path}]`
      return part.content
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  if (text) return text
  return `[${attachmentLabel}]`
}
