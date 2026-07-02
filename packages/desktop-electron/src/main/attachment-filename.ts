import path from "node:path"

const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export function safeAttachmentName(name: unknown) {
  const fallback = "attachment"
  if (typeof name !== "string" || name.trim().length === 0) return fallback

  let base = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "")
  base = base.slice(0, 160).replace(/[. ]+$/g, "")
  if (base.length === 0) return fallback
  if (WINDOWS_RESERVED_BASENAME.test(base)) base = `_${base}`
  return base
}
