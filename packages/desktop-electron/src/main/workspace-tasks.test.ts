import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { changeWorkspaceTask, nextReminderAt, readWorkspaceTasks, saveWorkspaceTask, takeDueReminders } from "./workspace-tasks"

test("persists file-linked completion history and fires each reminder once until snoozed", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pawwork-tasks-"))
  try {
    const now = new Date("2026-09-28T09:00:00.000Z")
    const dueAt = "2026-09-28T10:00:00.000Z"
    const tasks = saveWorkspaceTask(workspace, { title: "Check drawing", source: "drawing.pdf", description: "Verify scale", dueAt, reminderMinutes: 15 })
    const id = tasks[0]!.id
    expect(readWorkspaceTasks(workspace)[0]).toMatchObject({ id, source: "drawing.pdf", completedAt: null })
    expect(nextReminderAt(tasks[0]!)).toBe(Date.parse("2026-09-28T09:45:00.000Z"))
    expect(takeDueReminders(workspace, now)).toEqual([])
    expect(takeDueReminders(workspace, new Date("2026-09-28T09:45:00.000Z"))).toHaveLength(1)
    expect(takeDueReminders(workspace, new Date("2026-09-28T09:46:00.000Z"))).toEqual([])
    changeWorkspaceTask(workspace, id, "snooze", 5, new Date("2026-09-28T09:46:00.000Z"))
    expect(takeDueReminders(workspace, new Date("2026-09-28T09:50:00.000Z"))).toEqual([])
    expect(takeDueReminders(workspace, new Date("2026-09-28T09:51:00.000Z"))).toHaveLength(1)
    changeWorkspaceTask(workspace, id, "complete", undefined, new Date("2026-09-28T09:52:00.000Z"))
    expect(readWorkspaceTasks(workspace).filter((task) => task.source === "drawing.pdf" && task.completedAt)).toHaveLength(1)
    changeWorkspaceTask(workspace, id, "reopen", undefined, new Date("2026-09-28T09:53:00.000Z"))
    expect(readWorkspaceTasks(workspace)[0]!.completedAt).toBeNull()
    const edited = saveWorkspaceTask(workspace, { id, title: "Check revised drawing", source: "drawing.pdf", description: "Verify scale and title block", dueAt: "2026-09-28T11:00:00.000Z", reminderMinutes: 60 })
    expect(edited[0]).toMatchObject({ id, title: "Check revised drawing", description: "Verify scale and title block", completedAt: null })
    expect(readWorkspaceTasks(workspace)[0]!.dueAt).toBe("2026-09-28T11:00:00.000Z")
    changeWorkspaceTask(workspace, id, "delete")
    expect(readWorkspaceTasks(workspace)).toEqual([])
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
