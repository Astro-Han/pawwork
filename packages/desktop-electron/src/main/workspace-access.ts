import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { validWorkspaceDirectory } from "./launch-workspace"

type WorkspaceAccess = { version: 1; approved: string[]; last: string | null }
const emptyAccess = (): WorkspaceAccess => ({ version: 1, approved: [], last: null })

export function canonicalWorkspaceDirectory(value: unknown): string | undefined {
  const directory = validWorkspaceDirectory(value)
  if (!directory) return undefined
  try { return realpathSync(directory) } catch { return undefined }
}

function readAccess(path: string): WorkspaceAccess {
  try {
    if (lstatSync(path).isSymbolicLink() || statSync(path).size > 1_000_000) return emptyAccess()
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!value || typeof value !== "object") return emptyAccess()
    const data = value as Partial<WorkspaceAccess>
    if (data.version !== 1 || !Array.isArray(data.approved) || data.approved.length > 500 ||
      !data.approved.every((item) => typeof item === "string") ||
      (data.last !== null && typeof data.last !== "string")) return emptyAccess()
    return data as WorkspaceAccess
  } catch { return emptyAccess() }
}

export function hasApprovedWorkspace(path: string, workspace: string): boolean {
  if (!readAccess(path).approved.includes(workspace)) return false
  try { accessSync(workspace, constants.R_OK | constants.W_OK); return true } catch { return false }
}

export function lastApprovedWorkspace(path: string): string | undefined {
  const access = readAccess(path)
  const last = access.last
  return last && canonicalWorkspaceDirectory(last) === last && hasApprovedWorkspace(path, last) ? last : undefined
}

export function rememberWorkspace(path: string, workspace: string): void {
  if (canonicalWorkspaceDirectory(workspace) !== workspace) throw new Error("Choose an existing folder")
  const access = readAccess(path)
  const approved = [...access.approved.filter((item) => item !== workspace), workspace].slice(-500)
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Workspace access file cannot be a link")
  const temporary = join(parent, `.pawwork-access-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, approved, last: workspace }) + "\n", { encoding: "utf8", flag: "wx" })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
