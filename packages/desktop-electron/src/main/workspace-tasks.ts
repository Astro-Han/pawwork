import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type WorkspaceTask = {
  id: string
  title: string
  source: string | null
  description: string
  dueAt: string
  reminderMinutes: number
  snoozedUntil: string | null
  notifiedAt: string | null
  completedAt: string | null
}

export type TaskDraft = Pick<WorkspaceTask, "title" | "source" | "description" | "dueAt" | "reminderMinutes"> & { id?: string }

function taskFile(workspace: string) {
  const root = realpathSync(workspace)
  const directory = join(root, ".pawwork")
  const path = join(directory, "tasks.json")
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error("Tasks folder cannot be a link")
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Tasks file cannot be a link")
  return { directory, path }
}

export function readWorkspaceTasks(workspace: string): WorkspaceTask[] {
  const { path } = taskFile(workspace)
  if (!existsSync(path)) return []
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!Array.isArray(value) || value.length > 5000 || !value.every((task) =>
    task && typeof task === "object" && typeof task.id === "string" && !!task.id &&
    typeof task.title === "string" && !!task.title &&
    (task.source === null || typeof task.source === "string") && typeof task.description === "string" &&
    typeof task.dueAt === "string" && Number.isFinite(Date.parse(task.dueAt)) &&
    Number.isInteger(task.reminderMinutes) && task.reminderMinutes >= 1 && task.reminderMinutes <= 525600 &&
    (task.snoozedUntil === null || typeof task.snoozedUntil === "string" && Number.isFinite(Date.parse(task.snoozedUntil))) &&
    (task.notifiedAt === null || typeof task.notifiedAt === "string" && Number.isFinite(Date.parse(task.notifiedAt))) &&
    (task.completedAt === null || typeof task.completedAt === "string" && Number.isFinite(Date.parse(task.completedAt))))) {
    throw new Error("Tasks file is invalid")
  }
  return value as WorkspaceTask[]
}

function writeTasks(workspace: string, tasks: WorkspaceTask[]) {
  const { directory, path } = taskFile(workspace)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.pawwork-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n", { encoding: "utf8", flag: "wx" })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function saveWorkspaceTask(workspace: string, draft: TaskDraft): WorkspaceTask[] {
  if (!draft || typeof draft !== "object" || typeof draft.title !== "string" || !draft.title.trim() || draft.title.length > 200 ||
    typeof draft.description !== "string" || draft.description.length > 4000 ||
    (draft.source !== null && (typeof draft.source !== "string" || draft.source.length > 2000)) ||
    typeof draft.dueAt !== "string" || !Number.isFinite(Date.parse(draft.dueAt)) ||
    typeof draft.reminderMinutes !== "number" || !Number.isInteger(draft.reminderMinutes) ||
    draft.reminderMinutes < 1 || draft.reminderMinutes > 525600) throw new Error("Enter valid task details")
  const tasks = readWorkspaceTasks(workspace)
  const index = draft.id === undefined ? -1 : tasks.findIndex((task) => task.id === draft.id)
  if (draft.id !== undefined && index < 0) throw new Error("Task no longer exists")
  if (index < 0 && tasks.length >= 5000) throw new Error("Task limit reached")
  const task: WorkspaceTask = {
    id: index < 0 ? randomUUID() : tasks[index]!.id,
    title: draft.title.trim(), source: draft.source, description: draft.description.trim(),
    dueAt: new Date(draft.dueAt).toISOString(), reminderMinutes: draft.reminderMinutes,
    snoozedUntil: null, notifiedAt: null, completedAt: index < 0 ? null : tasks[index]!.completedAt,
  }
  if (index < 0) tasks.push(task)
  else tasks[index] = task
  writeTasks(workspace, tasks)
  return tasks
}

export function changeWorkspaceTask(workspace: string, id: string, action: "complete" | "reopen" | "snooze" | "delete", minutes?: number, now = new Date()): WorkspaceTask[] {
  const tasks = readWorkspaceTasks(workspace)
  const index = tasks.findIndex((task) => task.id === id)
  if (index < 0) throw new Error("Task no longer exists")
  if (action === "delete") tasks.splice(index, 1)
  else {
    const task = tasks[index]!
    if (action === "complete") task.completedAt = now.toISOString()
    else if (action === "reopen") { task.completedAt = null; task.notifiedAt = null }
    else if (action === "snooze") {
      if (minutes !== 5 && minutes !== 15) throw new Error("Choose a 5 or 15 minute snooze")
      task.snoozedUntil = new Date(now.getTime() + minutes * 60_000).toISOString()
      task.notifiedAt = null
    }
  }
  writeTasks(workspace, tasks)
  return tasks
}

export function nextReminderAt(task: WorkspaceTask) {
  return task.snoozedUntil ? Date.parse(task.snoozedUntil) : Date.parse(task.dueAt) - task.reminderMinutes * 60_000
}

export function takeDueReminders(workspace: string, now = new Date()): WorkspaceTask[] {
  const tasks = readWorkspaceTasks(workspace)
  const due = tasks.filter((task) => !task.completedAt && !task.notifiedAt && nextReminderAt(task) <= now.getTime())
  if (due.length) {
    for (const task of due) task.notifiedAt = now.toISOString()
    writeTasks(workspace, tasks)
  }
  return due
}
