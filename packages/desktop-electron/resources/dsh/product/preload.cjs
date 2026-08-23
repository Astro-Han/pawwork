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
})
