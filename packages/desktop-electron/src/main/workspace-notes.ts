import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"

function inside(root: string, target: string) {
  const path = relative(root, target)
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Choose a file inside the allowed folder")
  }
  return path
}

export function fileNotePath(workspace: string, source: string) {
  const root = realpathSync(workspace)
  const file = realpathSync(source)
  if (!lstatSync(file).isFile()) throw new Error("Choose a file")
  const path = inside(root, file)
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 12)
  const name = basename(file).replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 80)
  return { path: join(root, ".pawwork", "notes", `${name}-${hash}.md`), source: path }
}

export function pageNotePath(workspace: string, source: string, page: number) {
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new Error("Invalid PDF page")
  const file = fileNotePath(workspace, source)
  return { path: join(file.path.slice(0, -3), `page-${page}.md`), source: file.source }
}

function readText(path: string) {
  if (!existsSync(path)) return ""
  if (lstatSync(path).isSymbolicLink()) throw new Error("Notes file cannot be a link")
  return readFileSync(path, "utf8")
}

export function readWorkspaceNotes(workspace: string, source?: string) {
  const root = realpathSync(workspace)
  const memory = readText(join(root, "memory.md"))
  const file = source ? fileNotePath(root, source) : undefined
  const fileNotes = file ? readText(file.path).replace(/^<!-- PawWork source: .+ -->\r?\n\r?\n/, "") : ""
  return { workspace: root, source: file?.source ?? null, memory, fileNotes }
}

export function saveWorkspaceNotes(workspace: string, kind: "memory" | "file", content: string, source?: string) {
  if (typeof content !== "string" || content.length > 2_000_000) throw new Error("Notes are too large")
  const root = realpathSync(workspace)
  const file = kind === "file" && source ? fileNotePath(root, source) : undefined
  const target = kind === "memory" ? join(root, "memory.md") : file?.path
  if (!target) throw new Error("Choose a file first")
  const parent = kind === "memory" ? root : join(root, ".pawwork", "notes")
  if (kind === "file") {
    const notesRoot = join(root, ".pawwork")
    if (existsSync(notesRoot) && lstatSync(notesRoot).isSymbolicLink()) throw new Error("Notes folder cannot be a link")
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error("Notes folder cannot be a link")
    mkdirSync(parent, { recursive: true })
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("Notes file cannot be a link")
  const temporary = join(parent, `.pawwork-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, file ? `<!-- PawWork source: ${JSON.stringify(file.source)} -->\n\n${content}` : content, { encoding: "utf8", flag: "wx" })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
  return target
}

export function readPageNote(workspace: string, source: string, page: number) {
  const file = pageNotePath(workspace, source, page)
  return readText(file.path).replace(/^<!-- PawWork page: .+ -->\r?\n\r?\n/, "")
}

export function savePageNote(workspace: string, source: string, page: number, content: string) {
  if (typeof content !== "string" || content.length > 2_000_000) throw new Error("Notes are too large")
  const file = pageNotePath(workspace, source, page)
  const root = realpathSync(workspace)
  const notesRoot = join(root, ".pawwork")
  const pagesRoot = join(notesRoot, "notes")
  const parent = dirname(file.path)
  for (const path of [notesRoot, pagesRoot, parent]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Notes folder cannot be a link")
  }
  mkdirSync(parent, { recursive: true })
  if (existsSync(file.path) && lstatSync(file.path).isSymbolicLink()) throw new Error("Notes file cannot be a link")
  const temporary = join(parent, `.pawwork-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `<!-- PawWork page: ${JSON.stringify(file.source)}#${page} -->\n\n${content}`, { encoding: "utf8", flag: "wx" })
    renameSync(temporary, file.path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return file.path
}
