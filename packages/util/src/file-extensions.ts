export const OFFICE_EXTS = new Set(["doc", "docx", "ppt", "pptx", "xls", "xlsx"])

// Image extensions carry MIME values because direct attachments need a data URL media type.
export const IMAGE_EXTS = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])

export const TEXT_EXTS = new Set([
  "c",
  "cc",
  "conf",
  "cpp",
  "css",
  "csv",
  "dart",
  "gql",
  "go",
  "graphql",
  "html",
  "ini",
  "java",
  "js",
  "jsx",
  "json",
  "kt",
  "kts",
  "md",
  "proto",
  "properties",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sol",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
])

export function pathBasename(filepath: string) {
  const trimmed = filepath.replace(/[\\/]+$/, "")
  if (!trimmed) return filepath
  const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return trimmed.slice(sep + 1)
}

export function pathSuffix(filepath: string) {
  const base = pathBasename(filepath)
  const idx = base.lastIndexOf(".")
  if (idx <= 0 || idx === base.length - 1) return ""
  return base.slice(idx + 1).toLowerCase()
}
