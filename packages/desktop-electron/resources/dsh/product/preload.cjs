const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("pawworkFiles", {
  pick: () => ipcRenderer.invoke("pawwork:pick-conversation-files"),
})
