import fs from "node:fs"
import path from "path"
import { eq, isNull } from "../storage/db"
import { ProjectTable } from "../project/project.sql"
import { SessionTable } from "./session.sql"
import { rootContext } from "./execution-context"

type Tx = {
  select: (...args: any[]) => any
  update: (...args: any[]) => any
}

export function canonicalDirectory(input: string) {
  const abs = path.resolve(input)
  const real = (() => {
    try {
      return fs.realpathSync.native(abs)
    } catch {
      return abs
    }
  })()
  const normalized = path.normalize(real)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function backfillExecutionContextRows(d: Tx) {
  const rows = d
    .select({ id: SessionTable.id, directory: SessionTable.directory, project_id: SessionTable.project_id })
    .from(SessionTable)
    .where(isNull(SessionTable.execution_context))
    .all()
  for (const row of rows) {
    const project = d.select().from(ProjectTable).where(eq(ProjectTable.id, row.project_id)).get()
    const ownerDirectory = project?.vcs === "git" ? project.worktree : row.directory
    const ctx = rootContext(ownerDirectory)
    d.update(SessionTable).set({ execution_context: ctx }).where(eq(SessionTable.id, row.id)).run()
  }
  return rows.length
}
