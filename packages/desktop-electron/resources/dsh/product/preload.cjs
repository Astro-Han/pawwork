const { contextBridge, ipcRenderer } = require("electron")

let productReady = false
let publishTitlebarTheme = () => {}

function installBootStyle() {
  if (typeof document === "undefined" || document.documentElement === null) return false
  const style = document.createElement("style")
  style.textContent = `
[data-dsh-boot]:has([data-dsh-boot-spinner]) > * > :not([data-dsh-boot-spinner]) { display: none; }
[data-dsh-boot-spinner]::after {
  background: conic-gradient(#fc5c14 var(--dsh-boot-arc, 72deg), transparent 0);
}
@media (prefers-reduced-motion: reduce) {
  [data-dsh-boot-spinner] { animation: none !important; }
}`
  document.documentElement.appendChild(style)
  return true
}

function installTitlebarThemeSync() {
  if (typeof document === "undefined" || document.documentElement === null) return
  let published
  const publish = () => {
    if (!productReady) return
    const declared = document.documentElement.style?.colorScheme
    if ((declared !== "dark" && declared !== "light") || declared === published) return
    published = declared
    ipcRenderer.send("pawwork:titlebar-color-scheme", declared)
  }
  publishTitlebarTheme = publish
  publish()
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(publish).observe(document.documentElement, { attributeFilter: ["style"] })
  }
}

function installDocumentFeatures() {
  if (!installBootStyle()) return false
  installTitlebarThemeSync()
  return true
}

function installDocumentFeaturesWhenReady() {
  if (!installDocumentFeatures()) return
  document.removeEventListener("readystatechange", installDocumentFeaturesWhenReady)
}

if (!installDocumentFeatures() && typeof document !== "undefined") {
  document.addEventListener("readystatechange", installDocumentFeaturesWhenReady)
}

contextBridge.exposeInMainWorld("pawworkLifecycle", {
  ready: () => {
    ipcRenderer.send("pawwork:product-ready")
    productReady = true
    publishTitlebarTheme()
  },
})

contextBridge.exposeInMainWorld("pawworkFiles", {
  pick: () => ipcRenderer.invoke("pawwork:pick-conversation-files"),
  pickWorkspace: () => ipcRenderer.invoke("pawwork:pick-workspace-file"),
  readDocument: (name, data) => ipcRenderer.invoke("pawwork:read-uploaded-document", name, data),
  onDocumentProgress: (listener) => {
    const forward = (_event, message) => listener(message)
    ipcRenderer.on("pawwork:document-progress", forward)
    return () => ipcRenderer.removeListener("pawwork:document-progress", forward)
  },
})

contextBridge.exposeInMainWorld("pawworkAPI", {
  isSidebar: () => ipcRenderer.invoke("pawwork:is-sidebar"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:maximize-toggle"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  getCurrentDirectory: () => ipcRenderer.invoke("pawwork:get-current-directory"),
  getLaunchDirectory: () => ipcRenderer.invoke("pawwork:get-launch-directory"),
  setCurrentDirectory: (folder) => ipcRenderer.invoke("pawwork:set-current-directory", folder),
  createWorkspaceShortcut: (folder) => ipcRenderer.invoke("pawwork:create-workspace-shortcut", folder),
  openNotes: () => ipcRenderer.invoke("pawwork:open-notes"),
  onSummarizePdf: (listener) => {
    const forward = (_event, file) => listener(file)
    ipcRenderer.on("pawwork:summarize-pdf", forward)
    return () => ipcRenderer.removeListener("pawwork:summarize-pdf", forward)
  },
  onAnalyzeDocument: (listener) => {
    const forward = (_event, request) => listener(request)
    ipcRenderer.on("pawwork:analyze-document", forward)
    return () => ipcRenderer.removeListener("pawwork:analyze-document", forward)
  },
  onOpenWorkspace: (listener) => {
    const forward = (_event, folder) => listener(folder)
    ipcRenderer.on("pawwork:open-workspace", forward)
    return () => ipcRenderer.removeListener("pawwork:open-workspace", forward)
  },
  saveNote: (content, defaultName) => ipcRenderer.invoke("pawwork:save-note", content, defaultName),
  saveImage: (base64Data, defaultName) => ipcRenderer.invoke("pawwork:save-image", base64Data, defaultName),
  setReminder: (title, body, delayMs) => ipcRenderer.invoke("pawwork:set-reminder", title, body, delayMs),
})

contextBridge.exposeInMainWorld("pawworkCommunityMarket", {
  status: () => ipcRenderer.invoke("pawwork:dsh-community-market:status"),
  enable: () => ipcRenderer.invoke("pawwork:dsh-community-market:enable"),
  disable: () => ipcRenderer.invoke("pawwork:dsh-community-market:disable"),
  restart: () => ipcRenderer.send("pawwork:dsh-restart"),
})

contextBridge.exposeInMainWorld("pawworkUpdater", {
  getState: () => ipcRenderer.invoke("pawwork:updater:get-state"),
  check: () => ipcRenderer.invoke("pawwork:updater:check"),
  install: () => ipcRenderer.invoke("pawwork:updater:install"),
  openDownloadPage: () => ipcRenderer.send("pawwork:updater:open-download-page"),
  subscribe: (listener) => {
    const forward = (_event, payload) => listener(payload)
    ipcRenderer.on("pawwork:updater:state", forward)
    return () => ipcRenderer.removeListener("pawwork:updater:state", forward)
  },
})
