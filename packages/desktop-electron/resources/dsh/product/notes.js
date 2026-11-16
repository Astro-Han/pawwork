const api = window.pawworkNotes
const byId = (id) => document.getElementById(id)
const editor = byId("editor")
const status = byId("status")
let notes = { memory: "", fileNotes: "", source: null }
let saved = { memory: "", fileNotes: "" }
let kind = "memory"
let lastNotesKind = "memory"
let tasks = []
let editingInPending = false
let reminderQueue = []
let activeReminder = null
let loadedPage = 1
let savedPageNote = ""

function pageNumber() {
  const value = Number(byId("page").value)
  if (!Number.isInteger(value) || value < 1 || value > 100000) throw new Error("Enter a valid page number")
  return value
}

function hasUnsavedChanges() {
  return notes.memory !== saved.memory || notes.fileNotes !== saved.fileNotes || byId("page-note").value !== savedPageNote
}

async function loadPage() {
  if (!notes.source?.toLowerCase().endsWith(".pdf")) {
    byId("page-note").value = ""
    savedPageNote = ""
    return
  }
  try {
    loadedPage = pageNumber()
    savedPageNote = await api.readPage(loadedPage)
    byId("page-note").value = savedPageNote
  } catch (error) {
    status.textContent = error.message
  }
}

function show() {
  byId("workspace").textContent = notes.workspace || ""
  byId("source").textContent = notes.source || "No file selected"
  byId("source").title = notes.source || ""
  byId("notes-view").hidden = kind !== "memory" && kind !== "file"
  byId("tasks-view").hidden = kind !== "tasks"
  byId("pending-view").hidden = kind !== "pending"
  document.querySelector("footer").hidden = kind !== "memory" && kind !== "file"
  if (kind === "memory" || kind === "file") {
    byId("editor-label").textContent = kind === "memory" ? "Workspace memory — memory.md" : `Important points for ${notes.source || "a file"}`
    editor.value = kind === "memory" ? notes.memory : notes.fileNotes
    editor.disabled = kind === "file" && !notes.source
    byId("save").disabled = editor.disabled
  }
  byId("summarize").disabled = !notes.source?.toLowerCase().endsWith(".pdf")
  byId("pdf-tools").hidden = !notes.source?.toLowerCase().endsWith(".pdf")
  for (const tab of ["memory", "file", "tasks", "pending"]) {
    byId(`${tab}-tab`).classList.toggle("selected", kind === tab)
    byId(`${tab}-tab`).setAttribute("aria-current", kind === tab ? "page" : "false")
  }
  renderTasks()
}

async function load() {
  try {
    notes = await api.read()
    saved = { memory: notes.memory, fileNotes: notes.fileNotes }
    status.textContent = ""
    show()
    await loadPage()
    await loadTasks()
  } catch (error) {
    status.textContent = error.message
  }
}

function retainDraft() {
  if (kind === "memory") notes.memory = editor.value
  if (kind === "file") notes.fileNotes = editor.value
}

for (const value of ["memory", "file", "tasks", "pending"]) byId(`${value}-tab`).addEventListener("click", () => {
  retainDraft()
  if (value === "memory" || value === "file") lastNotesKind = value
  kind = value
  status.textContent = ""
  show()
  if (value === "tasks" && !byId("task-id").value) setTaskSource(lastNotesKind === "file" ? notes.source : null)
})

byId("choose-file").addEventListener("click", async () => {
  retainDraft()
  if (hasUnsavedChanges()) {
    status.textContent = "Save your changes before choosing another file."
    return
  }
  try {
    const selected = await api.chooseFile()
    if (selected.canceled) return
    notes = selected
    saved = { memory: notes.memory, fileNotes: notes.fileNotes }
    kind = "file"
    status.textContent = ""
    show()
    await loadPage()
    await loadTasks()
  } catch (error) {
    status.textContent = error.message
  }
})

byId("save").addEventListener("click", async () => {
  retainDraft()
  try {
    const result = await api.save(kind, editor.value)
    saved[kind === "memory" ? "memory" : "fileNotes"] = editor.value
    status.textContent = `Saved to ${result.path}`
  } catch (error) {
    status.textContent = error.message
  }
})

byId("summarize").addEventListener("click", async () => {
  try {
    await api.summarizePdf()
    status.textContent = "The agent is summarizing this PDF in PawWork."
  } catch (error) {
    status.textContent = error.message
  }
})

byId("page").addEventListener("change", async () => {
  if (byId("page-note").value !== savedPageNote) {
    byId("page").value = String(loadedPage)
    status.textContent = "Save this page annotation before switching pages."
    return
  }
  await loadPage()
})

byId("save-page").addEventListener("click", async () => {
  try {
    const result = await api.savePage(pageNumber(), byId("page-note").value)
    savedPageNote = byId("page-note").value
    status.textContent = `Saved to ${result.path}`
  } catch (error) {
    status.textContent = error.message
  }
})

byId("view-pdf").addEventListener("click", async () => {
  try {
    await api.openPdf(pageNumber())
    status.textContent = "PDF viewer opened."
  } catch (error) {
    status.textContent = error.message
  }
})

for (const action of ["ocr", "drawing", "compare"]) byId(action).addEventListener("click", async () => {
  try {
    const result = await api.analyze(action, pageNumber())
    status.textContent = result.canceled ? "Canceled" : "The agent is analyzing this page in PawWork."
  } catch (error) {
    status.textContent = error.message
  }
})

function feedback(message) {
  status.textContent = message
  clearTimeout(feedback.timer)
  feedback.timer = setTimeout(() => { if (status.textContent === message) status.textContent = "" }, 5000)
}

function fileLabel(source) {
  return source || "memory.md"
}

function formatDate(value) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function localDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function setTaskSource(source) {
  const select = byId("task-source")
  select.replaceChildren()
  for (const value of [null, notes.source, source]) {
    if (value !== null && !value) continue
    if ([...select.options].some((option) => option.value === (value ?? ""))) continue
    const option = document.createElement("option")
    option.value = value ?? ""
    option.textContent = value ? fileLabel(value) : "Workspace memory — memory.md"
    select.append(option)
  }
  select.value = source ?? ""
}

function taskButton(label, handler) {
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = label
  button.addEventListener("click", handler)
  return button
}

async function changeTask(id, action, minutes) {
  const previous = tasks
  const now = new Date()
  if (action !== "delete") {
    tasks = tasks.map((task) => task.id === id ? { ...task,
      completedAt: action === "complete" ? now.toISOString() : action === "reopen" ? null : task.completedAt,
      snoozedUntil: action === "snooze" ? new Date(now.getTime() + minutes * 60_000).toISOString() : task.snoozedUntil,
    } : task)
    renderTasks()
  }
  try {
    tasks = await api.changeTask(id, action, minutes)
    renderTasks()
    feedback(action === "complete" ? "Task completed." : action === "reopen" ? "Task reopened." : action === "snooze" ? `Snoozed for ${minutes} minutes.` : "Task deleted.")
  } catch (error) {
    tasks = previous
    renderTasks()
    status.textContent = error.message
  }
}

function editTask(task, inPending = false) {
  if (inPending) {
    editingInPending = true
    byId("task-edit-dialog").append(byId("task-form"))
    byId("task-edit-dialog").showModal()
  } else {
    kind = "tasks"
    show()
  }
  byId("task-id").value = task.id
  byId("task-title").value = task.title
  byId("task-description").value = task.description
  byId("task-due").value = localDateTime(new Date(task.dueAt))
  setTaskSource(task.source)
  const known = [5, 15, 60, 1440].includes(task.reminderMinutes)
  byId("task-offset").value = known ? String(task.reminderMinutes) : "custom"
  byId("task-custom-offset").value = String(task.reminderMinutes)
  showCustomOffset()
  byId("create-task").textContent = "Save Task"
  byId("cancel-edit").hidden = false
  byId("task-title").focus()
  if (!inPending) byId("tasks-view").scrollTop = 0
}

function deleteTask(task) {
  if (window.confirm(`Delete “${task.title}”?`)) void changeTask(task.id, "delete")
}

function taskCard(task, view) {
  const card = document.createElement("article")
  card.className = "task-card"
  const top = document.createElement("div")
  top.className = "task-card-top"
  const checkbox = document.createElement("input")
  checkbox.type = "checkbox"
  checkbox.checked = !!task.completedAt
  checkbox.setAttribute("aria-label", `${task.completedAt ? "Reopen" : "Complete"} ${task.title}`)
  checkbox.addEventListener("change", () => void changeTask(task.id, checkbox.checked ? "complete" : "reopen"))
  const title = document.createElement("span")
  title.className = "task-card-title"
  title.textContent = task.title
  top.append(checkbox, title)
  card.append(top)
  const meta = document.createElement("p")
  const badge = document.createElement("span")
  badge.className = `badge${!task.completedAt && Date.parse(task.dueAt) < Date.now() ? " overdue" : ""}`
  badge.textContent = task.completedAt ? "Completed" : Date.parse(task.dueAt) < Date.now() ? "Overdue" : "Pending"
  meta.append(badge, document.createTextNode(`${fileLabel(task.source)} · Due ${formatDate(task.dueAt)}`))
  card.append(meta)
  if (task.completedAt) {
    const completed = document.createElement("p")
    completed.textContent = `Completed on ${formatDate(task.completedAt)}`
    card.append(completed)
  }
  if (task.description) {
    const description = document.createElement("p")
    description.textContent = task.description
    card.append(description)
  }
  if (view !== "history") {
    const actions = document.createElement("div")
    actions.className = "task-card-actions"
    if (view === "upcoming") {
      actions.append(taskButton("Edit", () => editTask(task)), taskButton("Delete", () => deleteTask(task)))
    } else {
      actions.append(taskButton("Edit", () => editTask(task, true)),
        taskButton("Delete", () => deleteTask(task)),
        taskButton("Snooze 5m", () => void changeTask(task.id, "snooze", 5)),
        taskButton("Snooze 15m", () => void changeTask(task.id, "snooze", 15)),
        taskButton("Reschedule", () => { editTask(task, true); byId("task-due").focus() }))
    }
    card.append(actions)
  }
  return card
}

function fillTaskList(id, items, view, empty) {
  const list = byId(id)
  list.replaceChildren()
  if (!items.length) {
    const message = document.createElement("p")
    message.textContent = empty
    list.append(message)
  } else for (const task of items) list.append(taskCard(task, view))
}

function renderTasks() {
  const incomplete = tasks.filter((task) => !task.completedAt).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
  fillTaskList("upcoming-list", incomplete, "upcoming", "No upcoming tasks.")
  fillTaskList("pending-list", incomplete, "pending", "No pending tasks.")
  const selected = kind === "file" ? notes.source : null
  const completed = tasks.filter((task) => !!task.completedAt && task.source === selected)
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
  fillTaskList("history-list", completed, "history", "No completed tasks for this file.")
  byId("task-history").hidden = kind === "file" && !notes.source
}

async function loadTasks() {
  tasks = await api.listTasks()
  renderTasks()
}

function showCustomOffset() {
  const custom = byId("task-offset").value === "custom"
  byId("custom-offset-row").hidden = !custom
  byId("task-custom-offset").hidden = !custom
  byId("task-custom-offset").required = custom
}

byId("task-offset").addEventListener("change", showCustomOffset)
byId("task-due").value = localDateTime(new Date(Date.now() + 60 * 60_000))
setTaskSource(null)
function resetTaskForm() {
  if (editingInPending) {
    editingInPending = false
    if (byId("task-edit-dialog").open) byId("task-edit-dialog").close()
    byId("tasks-view").prepend(byId("task-form"))
  }
  byId("task-form").reset()
  byId("task-id").value = ""
  byId("create-task").textContent = "Create Task"
  byId("cancel-edit").hidden = true
  byId("task-due").value = localDateTime(new Date(Date.now() + 60 * 60_000))
  setTaskSource(lastNotesKind === "file" ? notes.source : null)
  showCustomOffset()
}
byId("cancel-edit").addEventListener("click", resetTaskForm)
byId("task-edit-dialog").addEventListener("close", () => { if (editingInPending) resetTaskForm() })
byId("task-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  try {
    const minutes = Number(byId("task-offset").value === "custom" ? byId("task-custom-offset").value : byId("task-offset").value)
    const draft = {
      id: byId("task-id").value || undefined,
      title: byId("task-title").value,
      source: byId("task-source").value || null,
      description: byId("task-description").value,
      dueAt: new Date(byId("task-due").value).toISOString(),
      reminderMinutes: minutes,
    }
    const editing = !!draft.id
    tasks = await api.saveTask(draft)
    byId("cancel-edit").click()
    renderTasks()
    feedback(editing ? "Task updated." : "Task created.")
  } catch (error) {
    status.textContent = error.message
  }
})

function showNextReminder() {
  const modal = byId("reminder-modal")
  if (modal.open) return
  const id = reminderQueue.shift()
  if (!id) return
  const task = tasks.find((item) => item.id === id && !item.completedAt)
  if (!task) { showNextReminder(); return }
  activeReminder = id
  byId("reminder-title").textContent = task.title
  byId("reminder-file").textContent = `Associated file: ${fileLabel(task.source)}`
  byId("reminder-due").textContent = `Due: ${formatDate(task.dueAt)}`
  byId("reminder-notes").textContent = task.description || "No additional notes."
  byId("reminder-complete").checked = false
  modal.showModal()
}

function closeReminder() {
  byId("reminder-modal").close()
  activeReminder = null
  showNextReminder()
}

byId("reminder-complete").addEventListener("change", () => {
  if (activeReminder) void changeTask(activeReminder, "complete")
  closeReminder()
})
for (const [button, minutes] of [["reminder-snooze-5", 5], ["reminder-snooze-15", 15]]) {
  byId(button).addEventListener("click", () => {
    if (activeReminder) void changeTask(activeReminder, "snooze", minutes)
    closeReminder()
  })
}
byId("reminder-dismiss").addEventListener("click", closeReminder)
byId("reminder-modal").addEventListener("close", () => { activeReminder = null; showNextReminder() })
api.onTasksChanged(() => void loadTasks().catch((error) => { status.textContent = error.message }))
api.onTaskReminder(async (id) => {
  try {
    await loadTasks()
    reminderQueue.push(id)
    showNextReminder()
  } catch (error) {
    status.textContent = error.message
  }
})

api.onChanged(() => {
  retainDraft()
  if (hasUnsavedChanges()) {
    status.textContent = "Save your changes before opening another file."
    return
  }
  void load()
})
api.onOpenFile(async (source) => {
  retainDraft()
  if (hasUnsavedChanges()) {
    status.textContent = "Save your changes before opening another file."
    return
  }
  try {
    notes = await api.openFile(source)
    saved = { memory: notes.memory, fileNotes: notes.fileNotes }
    kind = "file"
    status.textContent = ""
    show()
    await loadPage()
    await loadTasks()
  } catch (error) {
    status.textContent = error.message
  }
})
void load()
