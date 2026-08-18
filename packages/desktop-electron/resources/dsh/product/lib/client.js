window.__ModuleLoader__.load({
  id: "@pawwork/dsh-product",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const { useEffect, useRef } = require("react")

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
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
