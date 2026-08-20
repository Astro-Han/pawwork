import { JSON_SCHEMA, load } from "js-yaml"

export type UpdaterMetadataFile = {
  url: string
  sha512?: string
  size?: number
  blockMapSize?: number
}

export type UpdaterMetadata = {
  version?: string
  files: UpdaterMetadataFile[]
  path?: string
  releaseDate?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function parseUpdaterMetadata(source: string): UpdaterMetadata {
  const document = record(load(source, { schema: JSON_SCHEMA }))
  if (!document) return { files: [] }

  const files = Array.isArray(document.files)
    ? document.files.flatMap((value) => {
      const file = record(value)
      if (!file || typeof file.url !== "string") return []
      return [{
        url: file.url,
        ...(typeof file.sha512 === "string" ? { sha512: file.sha512 } : {}),
        ...(typeof file.size === "number" ? { size: file.size } : {}),
        ...(typeof file.blockMapSize === "number" ? { blockMapSize: file.blockMapSize } : {}),
      }]
    })
    : []

  return {
    files,
    ...(typeof document.version === "string" ? { version: document.version } : {}),
    ...(typeof document.path === "string" ? { path: document.path } : {}),
    ...(typeof document.releaseDate === "string" ? { releaseDate: document.releaseDate } : {}),
  }
}
