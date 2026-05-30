import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Automation } from "."
import { ProjectTable } from "@/project/project.sql"
import type { ProjectID } from "@/project/schema"
import { Timestamps } from "@/storage/schema.sql"

export const AutomationDefinitionTable = sqliteTable(
  "automation_definition",
  {
    id: text().primaryKey().$type<Automation.Definition["id"]>(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    owner_directory: text().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    data: text({ mode: "json" }).notNull().$type<Automation.Definition>(),
  },
  (table) => [
    index("automation_definition_project_owner_updated_idx").on(table.project_id, table.owner_directory, table.time_updated, table.id),
  ],
)

export const AutomationRunTable = sqliteTable(
  "automation_run",
  {
    id: text().primaryKey().$type<Automation.Run["id"]>(),
    automation_id: text()
      .notNull()
      .references(() => AutomationDefinitionTable.id, { onDelete: "cascade" }),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    owner_directory: text().notNull(),
    triggered_at: integer().notNull(),
    data: text({ mode: "json" }).notNull().$type<Automation.Run>(),
    ...Timestamps,
  },
  (table) => [
    index("automation_run_automation_triggered_idx").on(table.automation_id, table.triggered_at, table.id),
    index("automation_run_project_owner_idx").on(table.project_id, table.owner_directory),
  ],
)
