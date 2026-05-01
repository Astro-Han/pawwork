import z from "zod"
import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session"
import { ProjectTable } from "@/project/project.sql"
import { SessionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const id = (data as z.infer<typeof Session.Event.Updated.schema>).sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())

        if (!row) return data

        const project = Database.use((db) =>
          db
            .select({ worktree: ProjectTable.worktree, vcs: ProjectTable.vcs })
            .from(ProjectTable)
            .where(eq(ProjectTable.id, row.project_id))
            .get(),
        )

        return {
          sessionID: id,
          info: Session.fromRow(row, project),
        }
      }
      return data
    },
  })
}

initProjectors()
