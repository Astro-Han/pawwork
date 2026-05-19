import { Instance } from "@/project/instance"
import { Database, and, eq, inArray, isNull } from "@/storage/db"
import { SessionTable } from "./session.sql"
import { SessionID } from "./schema"

export namespace SessionLiveness {
  export function activeSessionIDs(sessionIDs: ReadonlyArray<SessionID>) {
    const unique = [...new Set(sessionIDs)]
    if (unique.length === 0) return new Set<SessionID>()

    const rows = Database.use((db) =>
      db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.project_id, Instance.project.id),
            isNull(SessionTable.time_archived),
            inArray(SessionTable.id, unique),
          ),
        )
        .all(),
    )

    return new Set(rows.map((row) => row.id))
  }
}
