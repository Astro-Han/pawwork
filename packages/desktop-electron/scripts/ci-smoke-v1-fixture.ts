import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const CI_SMOKE_V1_SESSION_ID = "ci-smoke-session"
export const CI_SMOKE_V1_AUTOMATION_ID = "ci-smoke-automation"
export const CI_SMOKE_IMPORTED_SESSION_ID = `pawwork-v1-${CI_SMOKE_V1_SESSION_ID}`
export const CI_SMOKE_IMPORTED_AUTOMATION_ID = `pawwork-v1-${CI_SMOKE_V1_AUTOMATION_ID}`

// The bulk sessions keep the migration in flight after the app window has
// connected: the client pulls the cold-session list only at connect time, so a
// one-session fixture finishes importing before that pull and even the pre-fix
// importer looks correct. The target session carries the largest time_created
// and lands last - while it is missing, the fix under test (poll
// /pawwork-import-v1, refresh the list once at completion) is the only path
// that can surface it in the sidebar without a reload.
export const CI_SMOKE_V1_BULK_SESSION_COUNT = 150

export function createCiSmokeV1Fixture(file: string, workspace: string) {
  mkdirSync(dirname(file), { recursive: true })
  const database = new DatabaseSync(file)
  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT,
        parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
        execution_context TEXT, title TEXT NOT NULL, version TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
        time_archived INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE automation_definition (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_directory TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE automation_run (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, project_id TEXT NOT NULL,
        owner_directory TEXT NOT NULL, triggered_at INTEGER NOT NULL, data TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
      );
    `)

    const insertSession = database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    const insertMessage = database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    const insertPart = database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")

    for (let index = 0; index < CI_SMOKE_V1_BULK_SESSION_COUNT; index += 1) {
      const sessionId = `ci-smoke-bulk-${index}`
      const created = index * 2 + 2
      insertSession.run(
        sessionId,
        "ci-smoke-project",
        "ci-smoke-workspace",
        null,
        sessionId,
        workspace,
        null,
        `V1 bulk session ${index}`,
        "1.0.0",
        created,
        created + 1,
        null,
      )
      insertMessage.run(
        `ci-smoke-bulk-message-${index}`,
        sessionId,
        created,
        created,
        JSON.stringify({
          role: "user",
          time: { created },
          agent: "build",
          model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
        }),
      )
      insertPart.run(
        `ci-smoke-bulk-part-${index}`,
        `ci-smoke-bulk-message-${index}`,
        sessionId,
        created,
        created,
        JSON.stringify({ type: "text", text: "Imported from PawWork V1" }),
      )
    }

    insertSession.run(
      CI_SMOKE_V1_SESSION_ID,
      "ci-smoke-project",
      "ci-smoke-workspace",
      null,
      "ci-smoke-session",
      workspace,
      null,
      "Imported V1 session",
      "1.0.0",
      1_000,
      2_000,
      null,
    )
    insertMessage.run(
      "ci-smoke-message",
      CI_SMOKE_V1_SESSION_ID,
      1_100,
      1_200,
      JSON.stringify({
        role: "user",
        time: { created: 1_100 },
        agent: "build",
        model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      }),
    )
    insertPart.run(
      "ci-smoke-part",
      "ci-smoke-message",
      CI_SMOKE_V1_SESSION_ID,
      1_100,
      1_200,
      JSON.stringify({ type: "text", text: "Imported from PawWork V1" }),
    )

    const automation = {
      id: CI_SMOKE_V1_AUTOMATION_ID,
      title: "Imported V1 automation",
      prompt: "Verify the migrated Automation definition.",
      revision: 1,
      paused: true,
      context: "fresh",
      where: { projectID: "ci-smoke-project" },
      createdAt: 1_000,
      updatedAt: 2_000,
      timezone: "UTC",
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      kind: "recurring",
      rhythm: { kind: "interval", everyMs: 60_000 },
      stop: { kind: "never" },
    }
    database.prepare("INSERT INTO automation_definition VALUES (?, ?, ?, ?, ?, ?)").run(
      CI_SMOKE_V1_AUTOMATION_ID,
      "ci-smoke-project",
      workspace,
      1_000,
      2_000,
      JSON.stringify(automation),
    )
  } finally {
    database.close()
  }
}
