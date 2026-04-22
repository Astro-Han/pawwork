import { isAbsolute, relative, resolve } from "node:path"

export const rendererProtocol = "pawwork-renderer"
export const rendererHost = "renderer"
export const rendererOrigin = `${rendererProtocol}://${rendererHost}`

export function rendererUrl(html: string) {
  if (!html || html.startsWith("/") || html.includes("\\") || html.split("/").includes("..")) {
    throw new Error(`Invalid renderer HTML path: ${html}`)
  }
  return `${rendererOrigin}/${html}`
}

export function resolveRendererFile(root: string, requestUrl: string) {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }

  if (url.protocol !== `${rendererProtocol}:`) return null
  if (url.hostname !== rendererHost) return null

  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }

  if (path.includes("\0") || path.includes("\\")) return null
  if (path !== "" && path !== "/" && path.endsWith("/")) return null
  const file = resolve(root, path === "" || path === "/" ? "index.html" : path.slice(1))
  const rel = relative(root, file)
  if (rel.startsWith("..") || isAbsolute(rel)) return null
  return file
}
