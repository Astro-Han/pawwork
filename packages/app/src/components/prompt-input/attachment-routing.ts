import { IMAGE_EXTS, OFFICE_EXTS, TEXT_EXTS, pathSuffix } from "@opencode-ai/util/file-extensions"
import { attachmentMime } from "./files"

type DirectInputKind = "image" | "pdf"
type ModelInputKind = "text" | DirectInputKind | "audio" | "video"
type ModelInputMap = Partial<Record<ModelInputKind, boolean>>

export type ModelInputSupport =
  | {
      capabilities?: {
        input?: ModelInputMap
      }
      modalities?: {
        input?: string[]
      }
    }
  | undefined

export type AttachRoute =
  | { type: "direct"; media: DirectInputKind; mime: string }
  | { type: "path"; reason: "text" | "office" | "unknown" | "unsupported-pdf" }
  | { type: "reject-image"; mime: string }

function routeMedia(mime: string, media: DirectInputKind, model: ModelInputSupport): AttachRoute {
  if (modelSupportsInput(model, media)) return { type: "direct", media, mime }
  if (media === "image") return { type: "reject-image", mime }
  return { type: "path", reason: "unsupported-pdf" }
}

export function modelSupportsInput(model: ModelInputSupport, kind: DirectInputKind) {
  const input = model?.capabilities?.input
  if (input?.[kind] === true) return true
  if (kind === "pdf" && input?.image === true) return true

  const modalities = model?.modalities?.input
  if (modalities?.includes(kind) === true) return true
  return kind === "pdf" && modalities?.includes("image") === true
}

export async function routeBrowserFile(file: File, model: ModelInputSupport): Promise<AttachRoute> {
  const mime = await attachmentMime(file)
  if (mime?.startsWith("image/")) return routeMedia(mime, "image", model)
  if (mime === "application/pdf") return routeMedia(mime, "pdf", model)
  if (mime?.startsWith("text/")) return { type: "path", reason: "text" }

  const suffix = pathSuffix(file.name)
  if (OFFICE_EXTS.has(suffix)) return { type: "path", reason: "office" }
  if (TEXT_EXTS.has(suffix)) return { type: "path", reason: "text" }
  return { type: "path", reason: "unknown" }
}

export function routePickedPath(path: string, model: ModelInputSupport): AttachRoute {
  const suffix = pathSuffix(path)
  const image = IMAGE_EXTS.get(suffix)
  if (image) return routeMedia(image, "image", model)
  if (suffix === "pdf") return routeMedia("application/pdf", "pdf", model)
  if (OFFICE_EXTS.has(suffix)) return { type: "path", reason: "office" }
  if (TEXT_EXTS.has(suffix)) return { type: "path", reason: "text" }
  return { type: "path", reason: "unknown" }
}
