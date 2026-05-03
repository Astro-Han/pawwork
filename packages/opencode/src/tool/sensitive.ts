import path from "path"

export type SensitiveStatus = "added" | "modified" | "deleted"

const SENSITIVE_SUBSTRINGS = ["credential", "credentials", "secret", "token", "private-key"]
const SENSITIVE_EXTERNAL_PARENT_SUBSTRINGS = ["credential", "secret", "private-key"]
const SENSITIVE_EXTERNAL_PARENT_SEGMENTS = new Set(["token", "tokens"])

export function isSensitivePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase()
  const segments = normalized.split("/").filter(Boolean)
  const basename = path.posix.basename(normalized)

  if (basename === ".env" || basename.startsWith(".env.")) return true
  if (basename.endsWith(".pem") || basename.endsWith(".key")) return true

  return segments.some((segment) => SENSITIVE_SUBSTRINGS.some((pattern) => segment.includes(pattern)))
}

export function sensitivityPath(filePath: string, root: string) {
  if (filePath === root || filePath.startsWith(root + path.sep)) return path.relative(root, filePath)
  return path.basename(filePath)
}

export function isSensitiveTargetPath(filePath: string, root: string) {
  if (filePath === root || filePath.startsWith(root + path.sep)) return isSensitivePath(path.relative(root, filePath))

  const normalized = filePath.replaceAll("\\", "/").toLowerCase()
  const segments = normalized.split("/").filter(Boolean)
  const basename = path.posix.basename(normalized)
  if (isSensitivePath(basename)) return true

  return segments
    .slice(0, -1)
    .some(
      (segment) =>
        SENSITIVE_EXTERNAL_PARENT_SEGMENTS.has(segment) ||
        SENSITIVE_EXTERNAL_PARENT_SUBSTRINGS.some((pattern) => segment.includes(pattern)),
    )
}

export function safeFileMetadata(file: string, status: SensitiveStatus) {
  return {
    file,
    status,
    sensitive: true,
  }
}

export function safeFilepathMetadata(filepath: string, status: SensitiveStatus, extra?: Record<string, unknown>) {
  return {
    filepath,
    status,
    sensitive: true,
    ...extra,
  }
}

function statusFromType(type: unknown, fallback: unknown): SensitiveStatus {
  if (fallback === "added" || fallback === "deleted" || fallback === "modified") return fallback
  if (type === "add") return "added"
  if (type === "delete") return "deleted"
  return "modified"
}

function object(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined
}

function fileFrom(value: Record<string, any>) {
  return value.file ?? value.filePath ?? value.filepath ?? value.relativePath
}

function isSensitiveMetadata(value: unknown): boolean {
  const meta = object(value)
  if (!meta) return false
  if (meta.sensitive === true) return true
  const file = fileFrom(meta)
  if (typeof file === "string" && isSensitivePath(file)) return true
  if (Array.isArray(meta.files) && meta.files.some(isSensitiveMetadata)) return true
  if (isSensitiveMetadata(meta.filediff)) return true
  return false
}

function sensitivePatchPaths(patchText: string) {
  const paths: string[] = []
  for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    paths.push(match[1]!.trim())
  }
  for (const match of patchText.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
    paths.push(match[1]!.trim())
  }
  return paths.filter(isSensitivePath)
}

function isSensitiveInput(value: unknown): boolean {
  const input = object(value)
  if (!input) return false
  if (typeof input.filePath === "string" && isSensitivePath(input.filePath)) return true
  if (typeof input.patchText === "string" && sensitivePatchPaths(input.patchText).length > 0) return true
  return false
}

export function sanitizeSensitiveDiffs<T extends { file: string; status?: SensitiveStatus }>(diffs: T[]) {
  return diffs.map((item) =>
    isSensitivePath(item.file)
      ? {
          ...item,
          status: item.status ?? "modified",
          ...("patch" in item ? { patch: "" } : {}),
          ...("additions" in item ? { additions: 0 } : {}),
          ...("deletions" in item ? { deletions: 0 } : {}),
          sensitive: true,
        }
      : item,
  )
}

export function sanitizeSensitiveFileEntry(value: unknown) {
  const item = object(value)
  if (!item) return value
  const file = fileFrom(item)
  const sensitive = item.sensitive === true || (typeof file === "string" && isSensitivePath(file))
  if (!sensitive) return value

  return {
    ...(typeof item.filePath === "string" ? { filePath: item.filePath } : {}),
    ...(typeof item.file === "string" ? { file: item.file } : {}),
    ...(typeof item.filepath === "string" ? { filepath: item.filepath } : {}),
    ...(typeof item.relativePath === "string" ? { relativePath: item.relativePath } : {}),
    ...(typeof item.type === "string" ? { type: item.type } : {}),
    ...(typeof item.movePath === "string" ? { movePath: item.movePath } : {}),
    status: statusFromType(item.type, item.status),
    sensitive: true,
  }
}

export function sanitizeSensitiveToolMetadata(metadata: unknown, input?: unknown) {
  const meta = object(metadata)
  if (!meta) return metadata
  const sensitive = isSensitiveMetadata(meta) || isSensitiveInput(input)
  if (!sensitive) return metadata

  const file = typeof meta.filepath === "string" ? meta.filepath : typeof meta.file === "string" ? meta.file : undefined
  const next: Record<string, unknown> = {}
  if (file) next[typeof meta.filepath === "string" ? "filepath" : "file"] = file
  if (Array.isArray(meta.files)) next.files = meta.files.map(sanitizeSensitiveFileEntry)
  if (meta.filediff) next.filediff = sanitizeSensitiveFileEntry(meta.filediff)
  if (meta.diagnostics !== undefined) next.diagnostics = {}
  if (meta.bomDiscarded === true) next.bomDiscarded = true
  next.status = statusFromType(meta.type, meta.status)
  next.sensitive = true
  return next
}

export function sanitizeSensitiveToolInput(tool: string, input: unknown, metadata?: unknown) {
  const value = object(input)
  if (!value) return input
  const sensitive = isSensitiveInput(value) || isSensitiveMetadata(metadata)
  if (!sensitive) return input

  if (typeof value.filePath === "string") {
    return {
      filePath: value.filePath,
      sensitive: true,
    }
  }
  if (tool === "apply_patch" && typeof value.patchText === "string") {
    return {
      files: sensitivePatchPaths(value.patchText).map((file) => ({ file, status: "modified", sensitive: true })),
      sensitive: true,
    }
  }
  return { sensitive: true }
}

export function sanitizeSensitiveToolPart<T extends { type: string; tool?: string; state?: any }>(part: T): T {
  if (part.type !== "tool" || !part.state || !part.tool) return part
  if (!("input" in part.state) && !("metadata" in part.state)) return part
  const input = sanitizeSensitiveToolInput(part.tool, part.state.input, part.state.metadata)
  const metadata = sanitizeSensitiveToolMetadata(part.state.metadata, part.state.input)
  const sensitive = input !== part.state.input || metadata !== part.state.metadata
  if (!sensitive) return part
  const output = typeof part.state.output === "string" ? "Sensitive file updated." : part.state.output
  return {
    ...part,
    state: {
      ...part.state,
      input,
      metadata,
      output,
      attachments: undefined,
    },
  }
}
