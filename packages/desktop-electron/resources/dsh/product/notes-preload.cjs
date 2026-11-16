const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("pawworkNotes", {
  read: () => ipcRenderer.invoke("pawwork:notes:read"),
  chooseFile: () => ipcRenderer.invoke("pawwork:notes:choose-file"),
  openFile: (source) => ipcRenderer.invoke("pawwork:notes:open-file", source),
  save: (kind, content) => ipcRenderer.invoke("pawwork:notes:save", kind, content),
  summarizePdf: () => ipcRenderer.invoke("pawwork:notes:summarize-pdf"),
  readPage: (page) => ipcRenderer.invoke("pawwork:notes:read-page", page),
  savePage: (page, content) => ipcRenderer.invoke("pawwork:notes:save-page", page, content),
  openPdf: (page) => ipcRenderer.invoke("pawwork:notes:open-pdf", page),
  analyze: (action, page) => ipcRenderer.invoke("pawwork:notes:analyze", action, page),
  listTasks: () => ipcRenderer.invoke("pawwork:tasks:list"),
  saveTask: (draft) => ipcRenderer.invoke("pawwork:tasks:save", draft),
  changeTask: (id, action, minutes) => ipcRenderer.invoke("pawwork:tasks:change", id, action, minutes),
  onTasksChanged: (listener) => {
    const forward = () => listener()
    ipcRenderer.on("pawwork:tasks:changed", forward)
    return () => ipcRenderer.removeListener("pawwork:tasks:changed", forward)
  },
  onTaskReminder: (listener) => {
    const forward = (_event, id) => listener(id)
    ipcRenderer.on("pawwork:tasks:reminder", forward)
    return () => ipcRenderer.removeListener("pawwork:tasks:reminder", forward)
  },
  onChanged: (listener) => {
    const forward = () => listener()
    ipcRenderer.on("pawwork:notes:changed", forward)
    return () => ipcRenderer.removeListener("pawwork:notes:changed", forward)
  },
  onOpenFile: (listener) => {
    const forward = (_event, source) => listener(source)
    ipcRenderer.on("pawwork:notes:open-file", forward)
    return () => ipcRenderer.removeListener("pawwork:notes:open-file", forward)
  },
})
