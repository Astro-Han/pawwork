import { Database, eq, isNull } from "../storage/db"
import { ProjectTable } from "../project/project.sql"
import { SessionTable } from "./session.sql"
import { canonicalDirectory, rootContext } from "./execution-context"

type Tx = Pick<Database.Transaction, "select" | "update">

export function backfillExecutionContextRows(d: Tx) {
  const rows = d
    .select({ id: SessionTable.id, directory: SessionTable.directory, project_id: SessionTable.project_id })
    .from(SessionTable)
    .where(isNull(SessionTable.execution_context))
    .all()
  for (const row of rows) {
    const project = d.select().from(ProjectTable).where(eq(ProjectTable.id, row.project_id)).get()
    const ownerDirectoryRaw = project?.vcs === "git" ? (project.worktree ?? row.directory) : row.directory
    const ownerDirectory = canonicalDirectory(ownerDirectoryRaw)
    const ctx = rootContext(ownerDirectory)
    d.update(SessionTable).set({ execution_context: ctx }).where(eq(SessionTable.id, row.id)).run()
  }
  return rows.length
}
