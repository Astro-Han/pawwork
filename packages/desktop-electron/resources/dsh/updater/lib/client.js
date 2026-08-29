// PawWork's in-app update UI. The Electron main process owns the updater state
// machine, the feed fallback, and the install; this plugin is pure presentation
// over the preload's window.pawworkUpdater bridge:
//
//   settings.section      — the discoverable home: version, status, actions.
//   shell.overlay         — a toast when (and only when) an update is ready.
//   sidebar.footer.action — a persistent indicator while an update is ready;
//                           clicking it resurfaces a dismissed toast.
//
// "Later" never discards the downloaded update: it only hides the toast for
// this window session, and the settings section keeps offering the install.

window.__ModuleLoader__.load({
  id: "@pawwork/dsh-updater",
  factory: (require) => {
    const { createElement, useEffect, useState } = require("react")
    const { Button, IconDownloadOutline16 } = require("@deepseek-ai/dsh-client-ui-primitives")
    const h = createElement

    const updaterCss = `
.pawwork-update-section { display: flex; flex-direction: column; gap: 16px; max-width: 680px; width: 100%; }
.pawwork-update-section h2 { font-size: 15px; font-weight: 600; line-height: 22px; margin: 0; }
.pawwork-update-copy { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; margin: 0; }
.pawwork-update-status {
  align-items: center; background: var(--dsw-alias-bg-module-platform); border-radius: 8px;
  display: flex; gap: 12px; justify-content: space-between; padding: 10px 12px;
}
.pawwork-update-status p { color: var(--dsw-alias-label-secondary); flex: 1; font-size: 12px; line-height: 19px; margin: 0; }
.pawwork-update-actions { display: flex; flex-shrink: 0; gap: 8px; white-space: nowrap; }
.pawwork-update-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 19px; margin: 0; word-break: break-all; }
.pawwork-update-toast {
  align-items: center; background: var(--dsw-alias-bg-module-platform); border-radius: 12px;
  bottom: 24px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18); display: flex; gap: 12px;
  padding: 12px 16px; pointer-events: auto; position: fixed; right: 24px; z-index: 60;
}
.pawwork-update-toast p { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; margin: 0; }
.pawwork-update-footer {
  align-items: center; background: transparent; border: 0; border-radius: 6px;
  color: var(--dsw-alias-label-secondary); display: inline-flex; gap: 6px; height: 28px;
  justify-content: center; padding: 0 6px;
}
.pawwork-update-footer:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pawwork-update-footer:focus-visible { outline: 2px solid #fc5c14; outline-offset: 1px; }
.pawwork-update-footer span { font-size: 12px; }
`

    function isChinese() { return document.documentElement.lang.startsWith("zh") }
    function text(chinese, english) { return isChinese() ? chinese : english }

    const FAILURE_COPY = {
      check: () => text("检查更新失败。", "The update check failed."),
      download: () => text("下载更新失败。", "The update download failed."),
      metadata: () => text("更新信息无效。", "The update metadata is invalid."),
      cache: () => text("更新缓存清理失败。", "Failed to clean up the update cache."),
    }

    // Normalizes the bridge payload plus local toast dismissal into one view
    // snapshot. The bridge is the authority for everything except `dismissed`,
    // which is window-session-local presentation state.
    function createUpdaterStore(bridge) {
      let snapshot = { status: bridge ? "loading" : "unavailable" }
      let dismissed = false
      let dismissedVersion
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) listener()
      }
      if (bridge) {
        bridge.subscribe((payload) => {
          snapshot = { status: payload.state.status, ...payload.state, progress: payload.progress, currentVersion: payload.currentVersion }
          // A newer ready version than the dismissed one deserves the toast again.
          if (payload.state.status === "ready" && dismissed && payload.state.version !== dismissedVersion) dismissed = false
          emit()
        })
        bridge.getState().then((payload) => {
          snapshot = { status: payload.state.status, ...payload.state, progress: payload.progress, currentVersion: payload.currentVersion }
          emit()
        }, () => {
          snapshot = { status: "unavailable" }
          emit()
        })
      }
      return {
        get: () => ({ ...snapshot, dismissed }),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        dismiss() {
          dismissed = true
          dismissedVersion = snapshot.version
          emit()
        },
        resurface() {
          dismissed = false
          emit()
        },
      }
    }

    function useUpdater(store) {
      const [value, setValue] = useState(() => store.get())
      useEffect(() => store.subscribe(() => setValue(store.get())), [store])
      return value
    }

    function downloadLabel(state) {
      const progress = state.status === "downloading" && typeof state.progress === "number"
        ? ` ${Math.round(state.progress * 100)}%`
        : ""
      return text(`正在下载 v${state.version}${progress}…`, `Downloading v${state.version}${progress}…`)
    }

    function statusCopy(state) {
      switch (state.status) {
        case "loading": return text("正在读取更新状态…", "Reading update status…")
        case "unavailable": return text("当前环境不提供自动更新。", "Automatic updates are unavailable in this environment.")
        case "idle": return text("尚未检查更新。", "Not checked yet.")
        case "checking": return text("正在检查更新…", "Checking for updates…")
        case "downloading": return downloadLabel(state)
        case "none": return text("已是最新版本。", "PawWork is up to date.")
        case "ready": return text(`v${state.version} 已就绪，重启后完成安装。`, `v${state.version} is ready. Restart to finish installing.`)
        case "failed": return (FAILURE_COPY[state.reason] ?? FAILURE_COPY.check)()
        default: return ""
      }
    }

    function UpdateSection({ store }) {
      const state = useUpdater(store)
      const bridge = window.pawworkUpdater
      const busy = state.status === "checking" || state.status === "downloading" || state.status === "loading"
      return h("section", { "aria-busy": busy, className: "pawwork-update-section" },
        h("div", null,
          h("h2", null, text("软件更新", "Software Update")),
          h("p", { className: "pawwork-update-copy" }, text("保持爪印为最新版本。更新在后台自动检查和下载。", "Keep PawWork up to date. Updates are checked and downloaded automatically in the background."))),
        state.currentVersion
          ? h("p", { className: "pawwork-update-copy" }, text(`当前版本 v${state.currentVersion}`, `Current version v${state.currentVersion}`))
          : null,
        h("div", { className: "pawwork-update-status", role: "status" },
          h("p", null, statusCopy(state)),
          h("div", { className: "pawwork-update-actions" },
            state.status === "ready"
              ? h(Button, { size: "sm", variant: "primary", onClick: () => bridge?.install() }, text("重新启动并安装", "Restart and Install"))
              : null,
            state.status === "failed"
              ? h(Button, { size: "sm", variant: "primary", onClick: () => bridge?.check() }, text("重试", "Retry"))
              : null,
            state.status === "failed" || state.status === "unavailable"
              ? h(Button, { size: "sm", onClick: () => bridge?.openDownloadPage() }, text("打开下载页", "Open Download Page"))
              : null,
            state.status === "idle" || state.status === "none"
              ? h(Button, { disabled: busy || !bridge, size: "sm", onClick: () => bridge?.check() }, text("检查更新", "Check for Updates"))
              : null)),
        state.status === "failed" && state.message
          ? h("p", { className: "pawwork-update-error", role: "alert" }, state.message)
          : null)
    }

    function UpdateReadyToast({ store }) {
      const state = useUpdater(store)
      const bridge = window.pawworkUpdater
      if (state.status !== "ready" || state.dismissed) return null
      return h("div", { className: "pawwork-update-toast", role: "status" },
        h("p", null, text(`新版本 v${state.version} 已就绪`, `v${state.version} is ready`)),
        h("div", { className: "pawwork-update-actions" },
          h(Button, { size: "sm", variant: "primary", onClick: () => bridge?.install() }, text("重启安装", "Restart and Install")),
          h(Button, { size: "sm", onClick: () => store.dismiss() }, text("稍后", "Later"))))
    }

    function UpdateFooterAction({ store, wide }) {
      const state = useUpdater(store)
      if (state.status !== "ready") return null
      const label = text("重启以更新", "Restart to update")
      return h("button", {
        "aria-label": label, className: "pawwork-update-footer", onClick: () => store.resurface(), title: label, type: "button",
      },
        h(IconDownloadOutline16, { size: 16 }),
        wide ? h("span", null, label) : null)
    }

    const inject = ["slots"]

    function apply(ctx) {
      const styleId = "@pawwork/dsh-updater/styles"
      if (document.querySelector(`style[data-plugin-css="${styleId}"]`) === null) {
        const style = document.createElement("style")
        style.dataset.plugin = "@pawwork/dsh-updater"
        style.dataset.pluginCss = styleId
        style.textContent = updaterCss
        document.head.appendChild(style)
      }
      const store = createUpdaterStore(window.pawworkUpdater)
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "pawwork-update", order: 50,
        label: () => text("软件更新", "Software Update"),
      }, () => h(UpdateSection, { store })))
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay", id: "pawwork-update-ready", order: 100,
      }, () => h(UpdateReadyToast, { store })))
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action", id: "pawwork-update", order: 100,
      }, (props) => h(UpdateFooterAction, { ...props, store })))
    }

    return { inject, apply }
  },
})
