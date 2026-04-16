import path from "node:path"

export function resolveOpencodeRoot(fromDir: string) {
  return path.resolve(fromDir, "../../opencode")
}
