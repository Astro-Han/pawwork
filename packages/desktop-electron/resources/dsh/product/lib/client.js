window.__ModuleLoader__.load({
  id: "@pawwork/dsh-product",
  factory: (require) => {
    const { createElement, useEffect, useRef } = require("react")
    const { IconPanelLeftOutline16 } = require("@deepseek-ai/dsh-client-ui-primitives")
    const h = createElement

    const productCss = `
.pawwork-sidebar-toggle { display: none; }
html[data-pawwork-platform="macos"] button[aria-label="收起侧边栏"]:not(.pawwork-sidebar-toggle),
html[data-pawwork-platform="macos"] button[aria-label="打开侧边栏"]:not(.pawwork-sidebar-toggle),
html[data-pawwork-platform="macos"] button[aria-label="Collapse sidebar"]:not(.pawwork-sidebar-toggle),
html[data-pawwork-platform="macos"] button[aria-label="Open sidebar"]:not(.pawwork-sidebar-toggle) { display: none; }
html[data-pawwork-platform="macos"] .pawwork-sidebar-toggle {
  -webkit-app-region: no-drag;
  align-items: center; background: transparent; border: 0; border-radius: 6px;
  color: var(--dsw-alias-label-secondary); cursor: pointer; display: inline-flex;
  height: 28px; justify-content: center; left: 76px; padding: 0; position: fixed;
  top: 9px; width: 28px;
}
html[data-pawwork-platform="macos"] .pawwork-sidebar-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
html[data-pawwork-platform="macos"] .pawwork-sidebar-toggle:active { background: var(--dsw-alias-interactive-bg-active); }
html[data-pawwork-platform="macos"] .pawwork-sidebar-toggle:focus-visible { outline: 2px solid #f36b2b; outline-offset: 1px; }
.pawwork-file-action {
  align-items: center; background: transparent; border: 0; border-radius: 6px;
  color: var(--dsw-alias-label-secondary); cursor: pointer; display: inline-flex;
  height: 28px; justify-content: center; padding: 0; width: 28px;
}
.pawwork-file-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pawwork-file-action:focus-visible { outline: 2px solid #f36b2b; outline-offset: 1px; }
.pawwork-file-action:disabled { cursor: default; opacity: 0.45; }
html[data-pawwork-platform="macos"] [data-sidebar-collapsed] > :first-child { border-right: 0; }
`

    const styleId = "@pawwork/dsh-product/identity"
    if (document.querySelector(`style[data-plugin-css="${styleId}"]`) === null) {
      const style = document.createElement("style")
      style.dataset.plugin = "@pawwork/dsh-product"
      style.dataset.pluginCss = styleId
      style.textContent = productCss
      document.head.appendChild(style)
    }
    if (document.documentElement?.dataset !== undefined) {
      const platform = typeof navigator === "undefined" ? "" : navigator.platform
      document.documentElement.dataset.pawworkPlatform = platform.startsWith("Mac") ? "macos" : "other"
    }

    function isChinese() { return document.documentElement.lang.startsWith("zh") }
    function text(chinese, english) { return isChinese() ? chinese : english }
    function icon(paths, size = 16) {
      return h("svg", { "aria-hidden": "true", fill: "none", height: size, viewBox: "0 0 24 24", width: size },
        ...paths.map((path, index) => h("path", { d: path, key: index, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 1.8 })))
    }

    function CompleteWelcomeNotice({ complete }) {
      const completed = useRef(false)
      useEffect(() => {
        if (completed.current) return
        completed.current = true
        complete()
      }, [complete])
      return null
    }

    function CompleteV1MigrationRefresh({ connection, sessions }) {
      useEffect(() => {
        let checking = false
        let stopped = false
        async function check() {
          if (checking || stopped) return
          checking = true
          try {
            const result = await connection.rpc.call("/pawwork-import-v1", "status", {})
            if (!result.ok || !result.value.sessionsComplete || stopped) return
            await sessions.refresh()
            if (!stopped) clearInterval(timer)
          } catch {
            // The importer may not be mounted yet; the next interval retries.
          } finally {
            checking = false
          }
        }
        const timer = setInterval(check, 500)
        void check()
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [connection, sessions])
      return null
    }

    function FileAction({ input, inputActions }) {
      if (window.pawworkFiles?.pick === undefined) return null
      async function chooseFiles() {
        const result = await window.pawworkFiles.pick()
        if (result.status === "canceled") return
        const heading = text("文件：", "Files:")
        const fileBlock = `${heading}\n${result.paths.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`
        inputActions.setDraft(input.draft === "" ? fileBlock : `${input.draft}\n\n${fileBlock}`)
      }
      const label = text("添加文件", "Add files")
      return h("button", { "aria-label": label, className: "pawwork-file-action", disabled: input.phase !== "plain", onClick: chooseFiles, title: label, type: "button" },
        icon(["M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"]))
    }

    function SidebarToggle({ toggleSidebar }) {
      const label = text("切换侧边栏", "Toggle sidebar")
      return h("button", { "aria-label": label, className: "pawwork-sidebar-toggle", onClick: toggleSidebar, title: label, type: "button" }, h(IconPanelLeftOutline16, { size: 16 }))
    }

    const inject = ["slots", "layout", "connection", "sessions"]
    function EmptyBrand() { return null }

    function apply(ctx) {
      ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register({ name: "sidebar.brand.mark", priority: -100 }, EmptyBrand))
      ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name", priority: -100 }, EmptyBrand))
      ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark", priority: -100 }, EmptyBrand))
      ctx.slots.inject("settings.onboarding", () => ctx.slots.register({ name: "settings.onboarding", id: "welcome-notice", order: -100, priority: -1 }, CompleteWelcomeNotice))
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "pawwork-files", order: -100 }, FileAction))
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "pawwork-sidebar-toggle", order: -100 }, () => h(SidebarToggle, { toggleSidebar: () => ctx.layout.toggleSidebar() })))
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "pawwork-v1-migration-refresh", order: -99 }, () => h(CompleteV1MigrationRefresh, { connection: ctx.connection, sessions: ctx.sessions })))
    }

    return { inject, apply }
  },
})
