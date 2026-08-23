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

function installTitlebarThemeSync() {
  if (typeof document === "undefined" || document.documentElement === null) return
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined
  let published
  const publish = () => {
    const declared = document.documentElement.style?.colorScheme
    const colorScheme = declared === "dark" || declared === "light" ? declared : media?.matches ? "dark" : "light"
    if (colorScheme === published) return
    published = colorScheme
    ipcRenderer.send("pawwork:titlebar-color-scheme", colorScheme)
  }
  publish()
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(publish).observe(document.documentElement, { attributeFilter: ["style"] })
  }
  media?.addEventListener?.("change", publish)
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
  ready: () => ipcRenderer.send("pawwork:product-ready"),
})

contextBridge.exposeInMainWorld("pawworkFiles", {
  pick: () => ipcRenderer.invoke("pawwork:pick-conversation-files"),
})
