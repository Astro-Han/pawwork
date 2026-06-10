import { onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { pathBasename } from "@opencode-ai/util/file-extensions"
import { attachmentMimeForPath } from "./attachment-chips-model"
import { showToast } from "@opencode-ai/ui/toast"
import {
  usePrompt,
  type AttachmentPart,
  type ContentPart,
  type FloatingAttachment,
  type ImageAttachmentPart,
} from "@/context/prompt"
import { useLanguage } from "@/context/language"
import type { useSync } from "@/context/sync"
import { uuid } from "@/utils/uuid"
import { getCursorPosition } from "./editor-dom"
import { textMime } from "./files"
import { normalizePaste, pasteMode } from "./paste"
import { routeBrowserFile, routePickedPath, type AttachRoute, type ModelInputSupport } from "./attachment-routing"
import { buildSlashRegistry } from "./command-text-part"
import { tryPathCConversion } from "./command-paste"

function dataUrlMimeCompatible(actual: string, expected: string) {
  if (actual === expected) return true
  if (!actual || actual === "application/octet-stream") return true
  if (expected !== "text/plain") return false
  return textMime(actual)
}

function isBase64Payload(value: string) {
  if (value.length % 4 !== 0) return false
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}

function dataUrl(file: File, mime: string) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const comma = value.indexOf(",")
      if (comma === -1) {
        resolve("")
        return
      }
      const header = value.slice(0, comma)
      const base64Marker = ";base64"
      if (!header.startsWith("data:") || !header.endsWith(base64Marker)) {
        resolve("")
        return
      }
      const actual = header.slice("data:".length, -base64Marker.length).toLowerCase()
      const payload = value.slice(comma + 1)
      if (!dataUrlMimeCompatible(actual, mime.toLowerCase()) || !isBase64Payload(payload)) {
        resolve("")
        return
      }
      resolve(`data:${mime};base64,${payload}`)
    })
    reader.readAsDataURL(file)
  })
}

type AttachmentFailureRoute = Exclude<AttachRoute, { type: "direct" }>
type AddResult = boolean | AttachmentFailureRoute

type PromptAttachmentsInput = {
  editor: () => HTMLDivElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  model: () => ModelInputSupport
  openModelSelector: () => void
  readFileDataUrl?: (path: string, mime: string) => Promise<string | null>
  filePathForBrowserFile?: (file: File) => Promise<string | null>
  saveAttachmentFile?: (file: File) => Promise<string | null>
  statPaths?: (paths: string[]) => Promise<Record<string, { size: number; exists: boolean }>>
  readClipboardImage?: () => Promise<File | null>
  // Path C (paste of `/<known-name> args` into structurally-empty input)
  // dependencies. Default to empty/false so callers that do not need pill
  // paste behaviour (e.g. legacy tests) can omit them.
  imageAttachments?: () => readonly FloatingAttachment[]
  composing?: () => boolean
  sync?: ReturnType<typeof useSync>
  externalReady?: () => boolean
}

export function createPromptAttachments(input: PromptAttachmentsInput) {
  const prompt = usePrompt()
  const language = useLanguage()

  const warn = () => {
    showToast({
      title: language.t("prompt.toast.pasteUnsupported.title"),
      description: language.t("prompt.toast.pasteUnsupported.description"),
    })
  }

  const pathRequired = () => {
    showToast({
      title: language.t("prompt.toast.pathRequired.title"),
      description: language.t("prompt.toast.pathRequired.description"),
    })
  }

  const warnImageUnsupported = () => {
    showToast({
      title: language.t("prompt.toast.imageUnsupported.title"),
      description: language.t("prompt.toast.imageUnsupported.description"),
      actions: [
        {
          label: language.t("prompt.toast.imageUnsupported.chooseModel"),
          onClick: input.openModelSelector,
        },
      ],
    })
  }

  const warnRouteFailure = (route: AttachmentFailureRoute) => {
    if (route.type === "reject-image") {
      warnImageUnsupported()
      return
    }
    pathRequired()
  }

  const addDirect = async (filename: string, mime: string, url: string) => {
    const editor = input.editor()
    if (!editor) return false

    if (!url) return false

    const attachment: ImageAttachmentPart = {
      type: "image",
      id: uuid(),
      filename,
      mime,
      dataUrl: url,
    }
    const cursor = prompt.cursor() ?? getCursorPosition(editor)
    prompt.set([...prompt.current(), attachment], cursor)
    return true
  }

  const attachmentSize = async (path: string) => {
    const stats = await input.statPaths?.([path]).catch(() => undefined)
    const stat = stats?.[path]
    return stat?.exists ? stat.size : undefined
  }

  // Entry-point attachments float as composer chips; same-path re-adds are
  // no-ops against both chips and inline `@` pills.
  const routePathFallback = async (path: string) => {
    const duplicate = prompt
      .current()
      .some((part) => (part.type === "attachment" || part.type === "file") && part.path === path)
    if (duplicate) return true
    const size = await attachmentSize(path)
    const attachment: AttachmentPart = {
      type: "attachment",
      id: uuid(),
      path,
      filename: pathBasename(path),
      mime: attachmentMimeForPath(path),
      size,
    }
    prompt.set([...prompt.current(), attachment], prompt.cursor())
    return true
  }

  const add = async (file: File, toast = true): Promise<AddResult> => {
    const filePath = await (async () => {
      const recovered = await input.filePathForBrowserFile?.(file).catch(() => null)
      if (recovered) return recovered
      if (!input.saveAttachmentFile) return null
      return input.saveAttachmentFile(file).catch(() => null)
    })()
    if (filePath) return addPickedPathResult(filePath, toast)
    if (input.saveAttachmentFile) {
      if (toast) pathRequired()
      return { type: "path", reason: "unknown" }
    }

    const route = await routeBrowserFile(file, input.model())
    if (route.type === "direct") {
      try {
        const ok = await addDirect(file.name, route.mime, await dataUrl(file, route.mime))
        if (!ok && toast) warn()
        return ok
      } catch {
        if (toast) warn()
        return false
      }
    }

    if (route.type === "reject-image") {
      if (toast) warnImageUnsupported()
      return route
    }

    if (route.type === "path" && route.reason === "text") {
      const ok = await addDirect(file.name, "text/plain", await dataUrl(file, "text/plain"))
      return ok ? true : route
    }

    if (toast) pathRequired()
    return route
  }

  const addAttachment = async (file: File) => (await add(file)) === true

  const addAttachments = async (files: File[], toast = true) => {
    let found = false
    let failure: AttachmentFailureRoute | undefined
    let directFailure = false

    for (const file of files) {
      const result = await add(file, false)
      if (result === true) {
        found = true
        continue
      }
      if (result === false) {
        directFailure = true
        continue
      }
      if (result) failure ??= result
    }

    if (toast) {
      if (failure) warnRouteFailure(failure)
      else if (directFailure) warn()
    }
    return found
  }

  const addPickedPathResult = async (path: string, toast = true, seen?: Set<string>): Promise<AddResult> => {
    if (seen?.has(path)) return true
    seen?.add(path)
    if (await routePathFallback(path)) return true
    const route = routePickedPath(path, input.model())
    if (route.type === "direct") return false
    return route
  }

  const addPickedPath = async (path: string, toast = true) => (await addPickedPathResult(path, toast)) === true

  const addPickedPaths = async (paths: string[]) => {
    let found = false
    let failure: AttachmentFailureRoute | undefined
    let directFailure = false
    const seen = new Set<string>()
    for (const path of paths) {
      const result = await addPickedPathResult(path, false, seen)
      if (result === true) {
        found = true
        continue
      }
      if (result === false) {
        directFailure = true
        continue
      }
      if (result) failure ??= result
    }
    if (failure) warnRouteFailure(failure)
    else if (directFailure) warn()
    return found
  }

  const removeAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => (part.type !== "image" && part.type !== "attachment") || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })

    if (files.length > 0) {
      await addAttachments(files)
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""

    // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
    if (input.readClipboardImage && !plainText) {
      // Same readiness gate as the synchronous onPaste check: a screenshot
      // paste reaches here without showing up as a `file` clipboard item, so
      // the upstream check can't see it.
      if (input.externalReady && !input.externalReady()) return
      const file = await input.readClipboardImage()
      if (file) {
        await addAttachment(file)
        return
      }
    }

    if (!plainText) return

    // Path C: command-shaped paste into structurally-empty input.
    // Runs against RAW clipboard text (NOT normalizePaste output) so command
    // boundary semantics stay verbatim. On miss → falls through to existing
    // text-insert path unchanged.
    if (input.sync) {
      const pathC = tryPathCConversion({
        plainText,
        currentPrompt: prompt.current(),
        contextItems: prompt.context.items(),
        imageAttachments: input.imageAttachments?.() ?? [],
        registry: buildSlashRegistry(input.sync.data.command),
        composing: input.composing?.() ?? false,
      })
      if (pathC) {
        const marked = pathC[0]
        prompt.set(pathC, "content" in marked ? marked.content.length : 0)
        return
      }
    }

    const text = normalizePaste(plainText)

    const put = () => {
      if (input.addPart({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor()
      return input.addPart({ type: "text", content: text, start: 0, end: 0 })
    }

    if (pasteMode(text) === "manual") {
      put()
      return
    }

    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
    if (inserted) return

    put()
  }

  const handleGlobalDragOver = (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (input.externalReady && !input.externalReady()) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      input.setDraggingType("image")
    } else if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (!event.relatedTarget) {
      input.setDraggingType(null)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (input.externalReady && !input.externalReady()) {
      // Cancel the native drop so Electron doesn't open the file or navigate
      // away from the app while the session is still opening.
      event.preventDefault()
      input.setDraggingType(null)
      return
    }

    event.preventDefault()
    input.setDraggingType(null)

    const plainText = event.dataTransfer?.getData("text/plain")
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = plainText.slice(filePrefix.length)
      input.focusEditor()
      input.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped || dropped.length === 0) {
      warn()
      return
    }

    await addAttachments(Array.from(dropped))
  }

  onMount(() => {
    makeEventListener(document, "dragover", handleGlobalDragOver)
    makeEventListener(document, "dragleave", handleGlobalDragLeave)
    makeEventListener(document, "drop", handleGlobalDrop)
  })

  return {
    addAttachment,
    addAttachments,
    addPickedPath,
    addPickedPaths,
    removeAttachment,
    handlePaste,
    handleGlobalDrop,
  }
}
