window.__ModuleLoader__.load({
  id: "@pawwork/dsh-product",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const { createElement, useEffect, useRef } = require("react")

    // DSH exposes onboarding as a slot, but not its shipped wordmark or shell chrome.
    // Keep that product delta here and verify it against every pinned DSH RC.
    const identityCss = `
div:has(> button > svg[viewBox="0 0 182 24"]) > button,
button:has(> svg[viewBox="0 0 23.16 17.04"]) {
  visibility: hidden;
}
span:has(> svg[viewBox="0 0 23.16 17.04"]) {
  display: none;
}
span:has(> svg[viewBox="0 0 23.16 17.04"]) + span {
  font-size: 0;
}
span:has(> svg[viewBox="0 0 23.16 17.04"]) + span::before {
  content: "PawWork";
  font-size: 26px;
}
html[lang^="zh"] span:has(> svg[viewBox="0 0 23.16 17.04"]) + span::before {
  content: "爪印";
}
span:has(> svg[viewBox="0 0 23.16 17.04"]) + span + span {
  display: none;
}
.pawwork-sidebar-toggle {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  display: inline-flex;
  height: 28px;
  justify-content: center;
  left: 12px;
  padding: 0;
  pointer-events: auto;
  position: absolute;
  top: 8px;
  width: 28px;
}
.pawwork-sidebar-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.pawwork-sidebar-toggle:focus-visible {
  outline: 2px solid #f36b2b;
  outline-offset: 1px;
}
html[data-pawwork-platform="macos"] .pawwork-sidebar-toggle {
  left: 72px;
}
[data-sidebar-collapsed] {
  margin-left: -56px;
  width: calc(100% + 56px);
}
[data-sidebar-collapsed] > :first-child {
  border-right: 0 !important;
  visibility: hidden;
}
[data-sidebar-collapsed] .pawwork-sidebar-toggle {
  left: 68px;
}
html[data-pawwork-platform="macos"] [data-sidebar-collapsed] .pawwork-sidebar-toggle {
  left: 128px;
}
[data-sidebar-collapsed] > :nth-child(2) header:first-of-type > :first-child {
  padding-left: 52px;
}
html[data-pawwork-platform="macos"] [data-sidebar-collapsed] > :nth-child(2) header:first-of-type > :first-child {
  padding-left: 104px;
}
.pawwork-file-action {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  display: inline-flex;
  height: 28px;
  justify-content: center;
  padding: 0;
  width: 28px;
}
.pawwork-file-action:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.pawwork-file-action:focus-visible {
  outline: 2px solid #f36b2b;
  outline-offset: 1px;
}
.pawwork-file-action:disabled {
  cursor: default;
  opacity: 0.45;
}
`
    const styleId = "@pawwork/dsh-product/identity"
    if (document.querySelector(`style[data-plugin-css="${styleId}"]`) === null) {
      const style = document.createElement("style")
      style.dataset.plugin = "@pawwork/dsh-product"
      style.dataset.pluginCss = styleId
      style.textContent = identityCss
      document.head.appendChild(style)
    }

    if (document.documentElement?.dataset !== undefined) {
      const platform = typeof navigator === "undefined" ? "" : navigator.platform
      document.documentElement.dataset.pawworkPlatform = platform.startsWith("Mac") ? "macos" : "other"
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

    function FileAction({ input, inputActions }) {
      if (window.pawworkFiles?.pick === undefined) return null
      const chinese = document.documentElement.lang.startsWith("zh")

      async function chooseFiles() {
        const result = await window.pawworkFiles.pick()
        if (result.status === "canceled") return
        const heading = chinese ? "文件：" : "Files:"
        const fileBlock = `${heading}\n${result.paths.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`
        inputActions.setDraft(input.draft === "" ? fileBlock : `${input.draft}\n\n${fileBlock}`)
      }

      const label = chinese ? "添加文件" : "Add files"
      return createElement(
        "button",
        {
          "aria-label": label,
          className: "pawwork-file-action",
          disabled: input.phase !== "plain",
          onClick: chooseFiles,
          title: label,
          type: "button",
        },
        createElement(
          "svg",
          {
            "aria-hidden": "true",
            fill: "none",
            height: 16,
            viewBox: "0 0 24 24",
            width: 16,
          },
          createElement("path", {
            d: "M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
            stroke: "currentColor",
            strokeLinecap: "round",
            strokeLinejoin: "round",
            strokeWidth: 1.8,
          }),
        ),
      )
    }

    function SidebarToggle({ toggleSidebar }) {
      const label = document.documentElement.lang.startsWith("zh") ? "切换侧边栏" : "Toggle sidebar"
      return createElement(
        "button",
        {
          "aria-label": label,
          className: "pawwork-sidebar-toggle",
          onClick: toggleSidebar,
          title: label,
          type: "button",
        },
        createElement(
          "svg",
          {
            "aria-hidden": "true",
            fill: "none",
            height: 16,
            viewBox: "0 0 24 24",
            width: 16,
          },
          createElement("rect", {
            height: 16,
            rx: 2,
            stroke: "currentColor",
            strokeWidth: 1.8,
            width: 18,
            x: 3,
            y: 4,
          }),
          createElement("path", {
            d: "M9 4v16",
            stroke: "currentColor",
            strokeWidth: 1.8,
          }),
        ),
      )
    }

    const inject = ["slots", "layout"]

    function apply(ctx) {
      document.title = "PawWork"
      ctx.slots.inject("settings.onboarding", () =>
        ctx.slots.register(
          {
            name: "settings.onboarding",
            id: "welcome-notice",
            order: -100,
            priority: -1,
          },
          CompleteWelcomeNotice,
        ),
      )
      // File paths stay plain draft text; DSH keeps sole ownership of session state and tool access.
      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register(
          {
            name: "conversation.input.left",
            id: "pawwork-files",
            order: -100,
          },
          FileAction,
        ),
      )
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "pawwork-sidebar-toggle",
            order: -100,
          },
          () => SidebarToggle({ toggleSidebar: () => ctx.layout.toggleSidebar() }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
