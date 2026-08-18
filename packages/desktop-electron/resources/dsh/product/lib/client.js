window.__ModuleLoader__.load({
  id: "@pawwork/dsh-product",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const { createElement, useEffect, useRef } = require("react")

    // DSH exposes onboarding as a slot, but not its shipped wordmark or hero.
    // Keep that product delta here and verify it against every pinned DSH RC.
    const identityCss = `
button:has(> svg[viewBox="0 0 182 24"]) {
  gap: 6px;
}
button:has(> svg[viewBox="0 0 182 24"]) > svg {
  display: none;
}
button:has(> svg[viewBox="0 0 182 24"])::before {
  content: "PawWork";
  color: var(--dsw-alias-label-primary);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
button:has(> svg[viewBox="0 0 182 24"])::after {
  content: "";
  width: 6px;
  height: 6px;
  background: #f36b2b;
  border-radius: 50%;
}
html[lang^="zh"] button:has(> svg[viewBox="0 0 182 24"])::before {
  content: "爪印";
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
button:has(> svg[viewBox="0 0 23.16 17.04"]) > svg[viewBox="0 0 23.16 17.04"] {
  display: none;
}
button:has(> svg[viewBox="0 0 23.16 17.04"])::before {
  content: "P";
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  font-weight: 700;
}
html[lang^="zh"] button:has(> svg[viewBox="0 0 23.16 17.04"])::before {
  content: "爪";
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

    const inject = ["slots"]

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
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
