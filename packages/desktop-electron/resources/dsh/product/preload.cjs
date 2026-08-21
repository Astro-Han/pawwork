const { contextBridge, ipcRenderer } = require("electron")

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

function installBootStyleWhenReady() {
  if (!installBootStyle()) return
  document.removeEventListener("readystatechange", installBootStyleWhenReady)
}

if (!installBootStyle() && typeof document !== "undefined") {
  document.addEventListener("readystatechange", installBootStyleWhenReady)
}

contextBridge.exposeInMainWorld("pawworkLifecycle", {
  ready: () => ipcRenderer.send("pawwork:product-ready"),
})

contextBridge.exposeInMainWorld("pawworkFiles", {
  pick: () => ipcRenderer.invoke("pawwork:pick-conversation-files"),
})
