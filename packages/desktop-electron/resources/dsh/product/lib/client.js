window.__ModuleLoader__.load({
  id: "@pawwork/dsh-product",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const { createElement, useEffect, useRef, useState } = require("react")
    const {
      Button,
      IconPanelLeftOutline16,
      IconPauseOutline16,
      IconPlayOutline16,
      IconRefreshOutline16,
      IconTrashOutline16,
      Modal,
    } = require("@deepseek-ai/dsh-client-ui-primitives")

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
  border-radius: 50%;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  display: inline-flex;
  height: 28px;
  justify-content: center;
  left: 12px;
  padding: 0;
  pointer-events: auto;
  position: fixed;
  top: 9px;
  width: 28px;
}
.pawwork-sidebar-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
html[data-pawwork-platform="macos"] .pawwork-sidebar-toggle {
  left: 76px;
}
[data-sidebar-collapsed] {
  margin-left: -56px;
  width: calc(100% + 56px);
}
[data-sidebar-collapsed] > :first-child {
  border-right: 0 !important;
  visibility: hidden;
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
.pawwork-automation-entry {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 12px;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  display: flex;
  flex: none;
  font-family: inherit;
  font-size: 14px;
  gap: 8px;
  height: 42px;
  line-height: 22px;
  margin: 4px -2px;
  overflow: hidden;
  padding: 0 10px 0 8px;
  width: calc(100% + 4px);
}
.pawwork-automation-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.pawwork-automation-entry:active {
  background: var(--dsw-alias-interactive-bg-active);
}
.pawwork-automation-entry:focus-visible {
  outline: 2px solid #f36b2b;
  outline-offset: -2px;
}
.pawwork-automation-entry[data-wide="false"] {
  border-radius: 50%;
  gap: 0;
  height: 36px;
  justify-content: center;
  margin: 0 0 12px;
  padding: 0;
  width: 36px;
}
.pawwork-automation-label {
  overflow: hidden;
  white-space: nowrap;
}
/* DSH exposes Automation only as a footer action. Keep that public contract,
 * then place the PawWork row after New Session without patching DSH itself. */
div:has(> div > div > div > .pawwork-automation-entry) > :nth-child(1) {
  order: 0;
}
div:has(> div > div > div > .pawwork-automation-entry) > :nth-child(2) {
  order: 1;
}
div:has(> div > div > div > .pawwork-automation-entry) > :nth-child(3) {
  order: 3;
}
div:has(> div > div > .pawwork-automation-entry),
div:has(> div > .pawwork-automation-entry),
div:has(> .pawwork-automation-entry) {
  display: contents;
}
.pawwork-automation-entry {
  order: 2;
}
div:has(> div > div > .pawwork-automation-entry) > :last-child {
  order: 4;
}
.pawwork-automations-modal {
  height: min(680px, calc(100vh - 72px));
  max-width: 920px;
  width: min(920px, calc(100vw - 72px));
}
.pawwork-automations-toolbar {
  align-items: center;
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
}
.pawwork-automations-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.pawwork-automations-count {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
}
.pawwork-automations-error {
  background: var(--dsw-alias-danger-bg-subtle, #fff0ed);
  border-radius: 8px;
  color: var(--dsw-alias-danger-label, #b9381d);
  font-size: 13px;
  margin-bottom: 12px;
  padding: 9px 11px;
}
.pawwork-automations-takeover {
  align-items: center;
  background: #fff6ee;
  border: 1px solid #f2d7c1;
  border-radius: 10px;
  display: flex;
  gap: 12px;
  justify-content: space-between;
  margin-bottom: 12px;
  padding: 10px 12px;
}
.pawwork-automations-takeover strong,
.pawwork-automations-takeover span {
  display: block;
}
.pawwork-automations-takeover span {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  margin-top: 2px;
}
.pawwork-automations-layout {
  border: 1px solid var(--dsw-alias-divider-border, #e8e6e3);
  border-radius: 12px;
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  height: calc(100% - 48px);
  min-height: 360px;
  overflow: hidden;
}
.pawwork-automations-list {
  background: var(--dsw-alias-bg-subtle, #faf9f7);
  border-right: 1px solid var(--dsw-alias-divider-border, #e8e6e3);
  overflow: auto;
  padding: 8px;
}
.pawwork-automation-row {
  background: transparent;
  border: 0;
  border-radius: 8px;
  color: inherit;
  cursor: pointer;
  display: block;
  font-family: inherit;
  padding: 9px 10px;
  text-align: left;
  width: 100%;
}
.pawwork-automation-row:hover,
.pawwork-automation-row[data-selected="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
}
.pawwork-automation-row-title {
  display: block;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pawwork-automation-row-meta {
  color: var(--dsw-alias-label-secondary);
  display: block;
  font-size: 11px;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pawwork-automations-empty {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  padding: 24px 14px;
  text-align: center;
}
.pawwork-automation-detail {
  overflow: auto;
  padding: 18px 20px 24px;
}
.pawwork-automation-detail-head {
  align-items: flex-start;
  display: flex;
  gap: 12px;
  justify-content: space-between;
}
.pawwork-automation-detail h3 {
  font-size: 17px;
  line-height: 24px;
  margin: 0;
}
.pawwork-automation-actions {
  display: flex;
  flex: none;
  gap: 6px;
}
.pawwork-automation-fields {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 18px 0;
}
.pawwork-automation-field {
  min-width: 0;
}
.pawwork-automation-field-label,
.pawwork-automation-history-label {
  color: var(--dsw-alias-label-secondary);
  display: block;
  font-size: 11px;
  margin-bottom: 4px;
}
.pawwork-automation-field-value {
  display: block;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.pawwork-automation-prompt {
  background: var(--dsw-alias-bg-subtle, #faf9f7);
  border-radius: 8px;
  font-size: 13px;
  line-height: 20px;
  margin: 0 0 18px;
  padding: 10px 12px;
  white-space: pre-wrap;
}
.pawwork-automation-run {
  align-items: center;
  border-top: 1px solid var(--dsw-alias-divider-border, #eceae7);
  display: flex;
  gap: 10px;
  justify-content: space-between;
  padding: 9px 0;
}
.pawwork-automation-run-main {
  min-width: 0;
}
.pawwork-automation-run-state {
  font-size: 12px;
  font-weight: 600;
}
.pawwork-automation-run-time {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  margin-left: 8px;
}
.pawwork-automation-run-summary {
  color: var(--dsw-alias-label-secondary);
  display: block;
  font-size: 11px;
  margin-top: 2px;
  max-width: 460px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pawwork-orphaned-history {
  border-top: 1px solid var(--dsw-alias-divider-border, #e8e6e3);
  margin-top: 10px;
  padding-top: 10px;
}
.pawwork-orphaned-history > span {
  color: var(--dsw-alias-label-secondary);
  display: block;
  font-size: 11px;
  padding: 0 10px 5px;
}
@media (max-width: 760px) {
  .pawwork-automations-modal {
    width: calc(100vw - 32px);
  }
  .pawwork-automations-layout {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .pawwork-automation-fields {
    grid-template-columns: 1fr;
  }
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
        createElement(IconPanelLeftOutline16, { size: 16 }),
      )
    }

    function createAutomationOverlayController() {
      let opened = false
      let setOpened = null
      return {
        attach(setter) {
          setOpened = setter
          setter(opened)
          return () => {
            if (setOpened === setter) setOpened = null
          }
        },
        close() {
          opened = false
          setOpened?.(false)
        },
        open() {
          opened = true
          setOpened?.(true)
        },
      }
    }

    function isChinese() {
      return document.documentElement.lang.startsWith("zh")
    }

    function workspaceName(cwd) {
      const parts = String(cwd).split(/[\\/]/).filter(Boolean)
      return parts.at(-1) || cwd
    }

    function formatTime(value) {
      if (value === null || value === undefined) return "—"
      return new Intl.DateTimeFormat(isChinese() ? "zh-CN" : "en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    }

    function formatSchedule(definition) {
      if (definition.kind === "oneshot") {
        return isChinese() ? `单次 · ${formatTime(definition.fireAt)}` : `Once · ${formatTime(definition.fireAt)}`
      }
      if (definition.rhythm.kind === "cron") {
        return `Cron ${definition.rhythm.expression} · ${definition.timezone}`
      }
      const seconds = definition.rhythm.everyMs / 1000
      if (seconds % 3600 === 0) return isChinese() ? `每 ${seconds / 3600} 小时` : `Every ${seconds / 3600}h`
      if (seconds % 60 === 0) return isChinese() ? `每 ${seconds / 60} 分钟` : `Every ${seconds / 60}m`
      return isChinese() ? `每 ${seconds} 秒` : `Every ${seconds}s`
    }

    function runState(run) {
      const labels = isChinese()
        ? { failed: "失败", running: "运行中", scheduled: "等待中", stopped: "已停止", succeeded: "已完成" }
        : { failed: "Failed", running: "Running", scheduled: "Scheduled", stopped: "Stopped", succeeded: "Completed" }
      return labels[run.state] || run.state
    }

    async function automationCall(connection, endpoint, payload, signal) {
      const result = await connection.rpc.call("/pawwork-automations", endpoint, payload, signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }

    function AutomationAction({ wide, controller }) {
      const label = document.documentElement.lang.startsWith("zh") ? "自动化" : "Automations"
      return createElement(
        "button",
        {
          "aria-label": label,
          className: "pawwork-automation-entry",
          "data-wide": wide ? "true" : "false",
          onClick: () => controller.open(),
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
            d: "M12 7v5l3 2m5.2-5A9 9 0 1 0 21 12",
            stroke: "currentColor",
            strokeLinecap: "round",
            strokeLinejoin: "round",
            strokeWidth: 1.8,
          }),
          createElement("path", {
            d: "M17 5h3.2v3.2",
            stroke: "currentColor",
            strokeLinecap: "round",
            strokeLinejoin: "round",
            strokeWidth: 1.8,
          }),
        ),
        wide ? createElement("span", { className: "pawwork-automation-label" }, label) : null,
      )
    }

    function RunRow({ run, sessions, close }) {
      const summary = run.error || run.stopReason || run.result
      const openLabel = isChinese() ? "打开会话" : "Open session"
      return createElement(
        "div",
        { className: "pawwork-automation-run", key: run.id },
        createElement(
          "div",
          { className: "pawwork-automation-run-main" },
          createElement("span", { className: "pawwork-automation-run-state" }, runState(run)),
          createElement("span", { className: "pawwork-automation-run-time" }, formatTime(run.triggeredAt)),
          summary ? createElement("span", { className: "pawwork-automation-run-summary" }, summary) : null,
        ),
        run.sessionId
          ? createElement(
            Button,
            {
              onClick: () => {
                sessions.open(run.sessionId)
                close()
              },
              size: "sm",
              variant: "outline",
            },
            openLabel,
          )
          : null,
      )
    }

    function AutomationOverlay({ controller, connection, sessions }) {
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [selectedId, setSelectedId] = useState(null)
      const [loading, setLoading] = useState(false)
      const [busy, setBusy] = useState("")
      const [error, setError] = useState("")
      const [confirmDelete, setConfirmDelete] = useState(false)
      const [confirmTakeover, setConfirmTakeover] = useState(false)

      useEffect(() => controller.attach(setOpen), [controller])

      async function load(signal) {
        setLoading(true)
        setError("")
        try {
          const next = await automationCall(connection, "list", {}, signal)
          setData(next)
          setSelectedId((current) => next.definitions.some((item) => item.id === current)
            ? current
            : (next.definitions[0]?.id || null))
        } catch (loadError) {
          if (!signal?.aborted) setError(loadError instanceof Error ? loadError.message : String(loadError))
        } finally {
          if (!signal?.aborted) setLoading(false)
        }
      }

      useEffect(() => {
        if (!open) return undefined
        const controller = new AbortController()
        void load(controller.signal)
        return () => controller.abort()
      }, [open])

      useEffect(() => {
        setConfirmDelete(false)
      }, [selectedId])

      async function mutate(endpoint, payload) {
        setBusy(endpoint)
        setError("")
        try {
          await automationCall(connection, endpoint, payload)
          await load()
        } catch (mutationError) {
          setError(mutationError instanceof Error ? mutationError.message : String(mutationError))
        } finally {
          setBusy("")
        }
      }

      const chinese = isChinese()
      const definitions = data?.definitions || []
      const selected = definitions.find((definition) => definition.id === selectedId) || null
      const pending = data?.pendingTakeover || []
      const orphanedRuns = data?.orphanedRuns || []
      const close = () => controller.close()
      const refreshLabel = chinese ? "刷新" : "Refresh"
      const body = createElement(
        "div",
        { className: "pawwork-automations-content" },
        createElement(
          "div",
          { className: "pawwork-automations-toolbar" },
          createElement(
            "span",
            { className: "pawwork-automations-count" },
            chinese ? `${definitions.length} 个自动化` : `${definitions.length} automations`,
          ),
          createElement(Button, {
            "aria-label": refreshLabel,
            disabled: loading,
            icon: createElement(IconRefreshOutline16, { size: 16 }),
            onClick: () => void load(),
            size: "sm",
            title: refreshLabel,
            variant: "toolbar",
          }),
        ),
        error ? createElement("div", { className: "pawwork-automations-error", role: "alert" }, error) : null,
        pending.length > 0
          ? createElement(
            "div",
            { className: "pawwork-automations-takeover" },
            createElement(
              "div",
              null,
              createElement("strong", null, chinese ? `${pending.length} 个 v1 自动化等待接管` : `${pending.length} v1 automations await takeover`),
              createElement("span", null, chinese ? "接管后只安排未来任务，不补跑错过的任务。" : "Only future runs will be scheduled; missed runs stay skipped."),
            ),
            createElement(
              Button,
              {
                disabled: busy !== "",
                onClick: () => {
                  if (!confirmTakeover) return setConfirmTakeover(true)
                  setConfirmTakeover(false)
                  void mutate("confirm-takeover", { confirmed: true })
                },
                size: "sm",
                variant: confirmTakeover ? "primary" : "outline",
              },
              confirmTakeover
                ? (chinese ? "确认接管" : "Confirm takeover")
                : (chinese ? "接管" : "Take over"),
            ),
          )
          : null,
        createElement(
          "div",
          { className: "pawwork-automations-layout" },
          createElement(
            "div",
            { className: "pawwork-automations-list" },
            loading && data === null
              ? createElement("div", { className: "pawwork-automations-empty" }, chinese ? "正在加载…" : "Loading…")
              : null,
            definitions.map((definition) => createElement(
              "button",
              {
                className: "pawwork-automation-row",
                "data-selected": definition.id === selectedId ? "true" : "false",
                key: definition.id,
                onClick: () => setSelectedId(definition.id),
                type: "button",
              },
              createElement("span", { className: "pawwork-automation-row-title" }, definition.title),
              createElement(
                "span",
                { className: "pawwork-automation-row-meta" },
                `${definition.paused ? (chinese ? "已暂停" : "Paused") : (chinese ? "运行中" : "Active")} · ${workspaceName(definition.cwd)}`,
              ),
            )),
            definitions.length === 0 && !loading
              ? createElement(
                "div",
                { className: "pawwork-automations-empty" },
                chinese ? "暂无自动化。在对话中告诉 PawWork 你想定时完成什么。" : "No automations yet. Create one in a conversation.",
              )
              : null,
            orphanedRuns.length > 0
              ? createElement(
                "div",
                { className: "pawwork-orphaned-history" },
                createElement("span", null, chinese ? `v1 历史记录 · ${orphanedRuns.length}` : `v1 history · ${orphanedRuns.length}`),
                orphanedRuns.slice(0, 10).map((run) => createElement(
                  "button",
                  {
                    className: "pawwork-automation-row",
                    disabled: !run.sessionId,
                    key: run.id,
                    onClick: () => {
                      sessions.open(run.sessionId)
                      close()
                    },
                    type: "button",
                  },
                  createElement("span", { className: "pawwork-automation-row-title" }, runState(run)),
                  createElement("span", { className: "pawwork-automation-row-meta" }, formatTime(run.triggeredAt)),
                )),
              )
              : null,
          ),
          selected
            ? createElement(
              "div",
              { className: "pawwork-automation-detail" },
              createElement(
                "div",
                { className: "pawwork-automation-detail-head" },
                createElement("h3", null, selected.title),
                createElement(
                  "div",
                  { className: "pawwork-automation-actions" },
                  createElement(
                    Button,
                    {
                      disabled: busy !== "" || selected.migration?.takeover === "pending",
                      icon: createElement(selected.paused ? IconPlayOutline16 : IconPauseOutline16, { size: 16 }),
                      onClick: () => void mutate("set-paused", { id: selected.id, paused: !selected.paused }),
                      size: "sm",
                      variant: "outline",
                    },
                    selected.paused ? (chinese ? "恢复" : "Resume") : (chinese ? "暂停" : "Pause"),
                  ),
                  createElement(
                    Button,
                    {
                      disabled: busy !== "" || selected.migration?.takeover === "pending",
                      icon: createElement(IconPlayOutline16, { size: 16 }),
                      onClick: () => void mutate("run-now", { id: selected.id }),
                      size: "sm",
                      variant: "outline",
                    },
                    chinese ? "立即运行" : "Run now",
                  ),
                  createElement(
                    Button,
                    {
                      disabled: busy !== "",
                      icon: createElement(IconTrashOutline16, { size: 16 }),
                      onClick: () => {
                        if (!confirmDelete) return setConfirmDelete(true)
                        setConfirmDelete(false)
                        void mutate("delete", { id: selected.id })
                      },
                      size: "sm",
                      variant: confirmDelete ? "primary" : "toolbar",
                    },
                    confirmDelete ? (chinese ? "确认删除" : "Confirm delete") : null,
                  ),
                ),
              ),
              createElement(
                "div",
                { className: "pawwork-automation-fields" },
                [
                  [chinese ? "状态" : "Status", selected.paused ? (chinese ? "已暂停" : "Paused") : (chinese ? "启用" : "Active")],
                  [chinese ? "计划" : "Schedule", formatSchedule(selected)],
                  [chinese ? "下次运行" : "Next run", formatTime(selected.nextFireAt)],
                  [chinese ? "工作区" : "Workspace", selected.cwd],
                  [chinese ? "模型" : "Model", `${selected.model.provider}/${selected.model.model}`],
                  [chinese ? "上下文" : "Context", selected.context === "continue" ? (chinese ? "继续原会话" : "Continue session") : (chinese ? "新会话" : "New session")],
                ].map(([label, value]) => createElement(
                  "div",
                  { className: "pawwork-automation-field", key: label },
                  createElement("span", { className: "pawwork-automation-field-label" }, label),
                  createElement("span", { className: "pawwork-automation-field-value" }, value),
                )),
              ),
              createElement("span", { className: "pawwork-automation-history-label" }, chinese ? "任务内容" : "Prompt"),
              createElement("pre", { className: "pawwork-automation-prompt" }, selected.prompt),
              createElement("span", { className: "pawwork-automation-history-label" }, chinese ? "最近运行" : "Recent runs"),
              selected.recentRuns.length > 0
                ? selected.recentRuns.map((run) => createElement(RunRow, { close, key: run.id, run, sessions }))
                : createElement("div", { className: "pawwork-automations-empty" }, chinese ? "还没有运行记录" : "No run history yet"),
            )
            : createElement(
              "div",
              { className: "pawwork-automations-empty" },
              chinese ? "选择一个自动化查看详情" : "Select an automation to view details",
            ),
        ),
      )

      return createElement(
        Modal,
        {
          className: "pawwork-automations-modal",
          closeLabel: chinese ? "关闭" : "Close",
          description: chinese ? "查看计划、运行记录并管理现有自动化。创建和编辑仍在对话中完成。" : "Review schedules and runs. Create and edit automations in conversation.",
          onClose: close,
          open,
          title: chinese ? "自动化" : "Automations",
        },
        body,
      )
    }

    const inject = ["slots", "layout", "connection", "sessions"]

    function apply(ctx) {
      document.title = "PawWork"
      const automationOverlay = createAutomationOverlayController()
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
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "pawwork-automations-overlay",
            order: -90,
          },
          () => createElement(AutomationOverlay, {
            connection: ctx.connection,
            controller: automationOverlay,
            sessions: ctx.sessions,
          }),
        ),
      )
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "pawwork-automations",
            order: -100,
          },
          (props) => AutomationAction({ ...props, controller: automationOverlay }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
