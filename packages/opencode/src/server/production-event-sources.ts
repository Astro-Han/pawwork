// Keep /doc event schemas aligned with the production server modules that define SSE payloads.
import "@/automation"
import "@/bus"
import "@/command"
import "@/control-plane/workspace"
import "@/file"
import "@/file/watcher"
import "@/installation"
import "@/lsp"
import "@/lsp/client"
import "@/mcp"
import "@/permission"
import "@/project/project"
import "@/project/vcs"
import "@/pty"
import "@/server/event"
// Installs the latest SyncEvent definitions onto BusEvent for production SSE schemas.
import "@/server/projectors"
import "@/session/compaction"
import "@/session/message-v2"
import "@/session/session"
import "@/session/status"
import "@/session/todo"
import "@/worktree"

export const productionBusEventTypes = [
  "automation.definition.deleted",
  "automation.definition.updated",
  "automation.run.updated",
  "command.executed",
  "file.edited",
  "file.watcher.rescan",
  "file.watcher.updated",
  "global.disposed",
  "installation.update-available",
  "installation.updated",
  "lsp.client.diagnostics",
  "lsp.server.install.failed",
  "lsp.updated",
  "mcp.browser.open.failed",
  "mcp.tools.changed",
  "message.part.delta",
  "message.part.removed",
  "message.part.updated",
  "message.removed",
  "message.updated",
  "permission.asked",
  "permission.replied",
  "project.updated",
  "pty.created",
  "pty.deleted",
  "pty.exited",
  "pty.updated",
  "server.connected",
  "server.instance.disposed",
  "session.compacted",
  "session.created",
  "session.deleted",
  "session.diff",
  "session.error",
  "session.idle",
  "session.status",
  "session.turn_change_invalidated",
  "session.updated",
  "todo.updated",
  "vcs.branch.updated",
  "workspace.failed",
  "workspace.ready",
  "workspace.status",
  "worktree.failed",
  "worktree.ready",
] as const

export const productionSyncEventTypes = [
  "message.part.removed",
  "message.part.updated",
  "message.removed",
  "message.updated",
  "session.created",
  "session.deleted",
  "session.updated",
] as const
