window.__ModuleLoader__.load({
  id: "@pawwork/dsh-product",
  factory: (require) => {
    const { createElement, useEffect, useRef, useState } = require("react")
    const {
      Button,
      DisclosureRow,
      Input,
      Menu,
      Pill,
      StateDot,
      IconChevronDownOutline14,
      IconCloseOutline16,
      IconPanelLeftOutline16,
      IconPauseOutline16,
      IconPlayOutline16,
      IconSearchOutline16,
      IconSettingsOutline16,
      IconTrashOutline16,
    } = require("@deepseek-ai/dsh-client-ui-primitives")
    const h = createElement

    // DSH exposes public product slots, but not product identity or a page router.
    // PawWork keeps those two product deltas here and shadows the public
    // conversation slot only while its Automation page is open.
    const productCss = `
div:has(> button > svg[viewBox="0 0 182 24"]) > button,
button:has(> svg[viewBox="0 0 23.16 17.04"]) { visibility: hidden; }
span:has(> svg[viewBox="0 0 23.16 17.04"]) { display: none; }
span:has(> svg[viewBox="0 0 23.16 17.04"]) + span { font-size: 0; }
span:has(> svg[viewBox="0 0 23.16 17.04"]) + span::before { content: "PawWork"; font-size: 26px; }
html[lang^="zh"] span:has(> svg[viewBox="0 0 23.16 17.04"]) + span::before { content: "爪印"; }
span:has(> svg[viewBox="0 0 23.16 17.04"]) + span + span { display: none; }
.pawwork-sidebar-toggle {
  align-items: center; background: transparent; border: 0; border-radius: 50%;
  color: var(--dsw-alias-label-secondary); cursor: pointer; display: inline-flex;
  height: 28px; justify-content: center; left: 12px; padding: 0; pointer-events: auto;
  position: fixed; top: 9px; width: 28px;
}
.pawwork-sidebar-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
html[data-pawwork-platform="macos"] .pawwork-sidebar-toggle { left: 76px; }
[data-sidebar-collapsed] { margin-left: -56px; width: calc(100% + 56px); }
[data-sidebar-collapsed] > :first-child { border-right: 0 !important; visibility: hidden; }
[data-sidebar-collapsed] > :nth-child(2) header:first-of-type > :first-child { padding-left: 52px; }
html[data-pawwork-platform="macos"] [data-sidebar-collapsed] > :nth-child(2) header:first-of-type > :first-child { padding-left: 104px; }
.pawwork-file-action {
  align-items: center; background: transparent; border: 0; border-radius: 6px;
  color: var(--dsw-alias-label-secondary); cursor: pointer; display: inline-flex;
  height: 28px; justify-content: center; padding: 0; width: 28px;
}
.pawwork-file-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pawwork-file-action:focus-visible { outline: 2px solid #f36b2b; outline-offset: 1px; }
.pawwork-file-action:disabled { cursor: default; opacity: 0.45; }
.pawwork-automation-entry {
  align-items: center; background: transparent; border: 0; border-radius: 12px;
  box-sizing: border-box; color: var(--dsw-alias-label-primary); cursor: pointer;
  display: flex; flex: none; font-family: inherit; font-size: 14px; gap: 8px;
  height: 42px; line-height: 22px; margin: 4px -2px; overflow: hidden;
  padding: 0 10px 0 8px; width: calc(100% + 4px);
}
.pawwork-automation-entry:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pawwork-automation-entry:active { background: var(--dsw-alias-interactive-bg-active); }
.pawwork-automation-entry:focus-visible { outline: 2px solid #f36b2b; outline-offset: -2px; }
.pawwork-automation-entry[data-active="true"] { background: var(--dsw-alias-interactive-bg-active); font-weight: 500; }
.pawwork-automation-entry[data-wide="false"] {
  border-radius: 50%; gap: 0; height: 36px; justify-content: center;
  margin: 0 0 12px; padding: 0; width: 36px;
}
.pawwork-automation-label { overflow: hidden; white-space: nowrap; }
/* DSH currently exposes this product action in the footer. Reordering the
 * public row places it after New Session without patching DSH internals. */
div:has(> div > div > div > .pawwork-automation-entry) > :nth-child(1) { order: 0; }
div:has(> div > div > div > .pawwork-automation-entry) > :nth-child(2) { order: 1; }
div:has(> div > div > div > .pawwork-automation-entry) > :nth-child(3) { order: 3; }
div:has(> div > div > .pawwork-automation-entry),
div:has(> div > .pawwork-automation-entry),
div:has(> .pawwork-automation-entry) { display: contents; }
.pawwork-automation-entry { order: 2; }
div:has(> div > div > .pawwork-automation-entry) > :last-child { order: 4; }
.pawwork-automations-surface {
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  display: flex; height: 100%; min-height: 0; min-width: 0; width: 100%;
}
.pawwork-automations-main {
  display: flex; flex: 1; justify-content: center; min-width: 0; overflow: auto;
  padding: 56px 32px 48px;
}
.pawwork-automations-surface[data-split="true"] .pawwork-automations-main {
  border-right: 1px solid var(--dsw-alias-divider-border);
  flex: 0 0 320px; justify-content: stretch; padding: 32px 20px;
}
.pawwork-automations-overview { max-width: 720px; width: 100%; }
.pawwork-automations-surface[data-split="true"] .pawwork-automations-overview { max-width: none; }
.pawwork-automations-titlebar {
  align-items: flex-start; display: flex; gap: 20px; justify-content: space-between; margin-bottom: 20px;
}
.pawwork-automations-titlebar h1 {
  font-size: 16px; font-weight: 500; line-height: 24px; margin: 0;
}
.pawwork-automations-titlebar p {
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; margin: 2px 0 0;
}
.pawwork-automations-surface[data-split="true"] .pawwork-automations-titlebar p { display: none; }
.pawwork-automations-title-actions { align-items: center; display: flex; flex: none; gap: 8px; }
.pawwork-automations-search, .pawwork-automations-search input { width: 100%; }
.pawwork-automations-tabs { display: flex; gap: 6px; margin: 16px 0 10px; }
.pawwork-automation-row {
  align-items: center; background: transparent; border: 0; border-radius: 10px;
  color: inherit; cursor: pointer; display: grid; font: inherit; gap: 10px;
  grid-template-columns: 20px minmax(0, 1fr); min-height: 58px;
  padding: 8px 12px; text-align: left; width: 100%;
}
.pawwork-automation-row:hover, .pawwork-automation-row[data-selected="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.pawwork-automation-row:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.pawwork-automation-row-icon { color: var(--dsw-alias-label-secondary); display: inline-flex; }
.pawwork-automation-row-title, .pawwork-automation-row-meta {
  display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pawwork-automation-row-title { font-size: 14px; line-height: 22px; }
.pawwork-automation-row-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.pawwork-automations-empty, .pawwork-automations-loading {
  color: var(--dsw-alias-label-secondary); font-size: 13px; padding: 36px 12px; text-align: center;
}
.pawwork-automations-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; margin: 12px 0; }
.pawwork-automation-panel { flex: 1; min-width: 0; overflow: auto; padding: 32px 40px 48px; }
.pawwork-automation-panel-inner { margin: 0 auto; max-width: 720px; }
.pawwork-automation-panel-head {
  align-items: center; display: flex; gap: 12px; justify-content: space-between; margin-bottom: 20px;
}
.pawwork-automation-panel-head h2 { font-size: 16px; font-weight: 500; line-height: 24px; margin: 0; }
.pawwork-automation-actions { align-items: center; display: flex; gap: 6px; }
.pawwork-automation-form { border-top: 1px solid var(--dsw-alias-divider-border); }
.pawwork-automation-group {
  align-items: center; border-bottom: 1px solid var(--dsw-alias-divider-border); display: grid;
  gap: 24px; grid-template-columns: 148px minmax(0, 1fr); min-height: 64px; padding: 12px 0;
}
.pawwork-automation-group[data-multiline="true"] { align-items: start; }
.pawwork-automation-group-label { font-size: 14px; line-height: 22px; }
.pawwork-automation-input, .pawwork-automation-input input { width: 100%; }
.pawwork-automation-textarea {
  background: var(--dsw-alias-bg-subtle); border: 1px solid var(--dsw-alias-divider-border);
  border-radius: 8px; box-sizing: border-box; color: var(--dsw-alias-label-primary);
  font: inherit; line-height: 22px; min-height: 116px; padding: 10px 12px; resize: vertical; width: 100%;
}
.pawwork-automation-select-trigger { justify-content: space-between; max-width: 100%; min-width: 148px; }
.pawwork-automation-select-trigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pawwork-automation-grid { display: contents; }
.pawwork-automation-advanced { border-bottom: 1px solid var(--dsw-alias-divider-border); padding: 12px 0; }
.pawwork-automation-advanced-content { border-top: 1px solid var(--dsw-alias-divider-border); margin-top: 12px; }
.pawwork-automation-form-footer {
  align-items: center; display: flex; gap: 8px; justify-content: flex-end; padding-top: 16px;
}
.pawwork-automation-discard { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-right: auto; }
.pawwork-automation-history {
  border-top: 1px solid var(--dsw-alias-divider-border); margin-top: 28px; padding-top: 18px;
}
.pawwork-automation-history h3 { font-size: 14px; font-weight: 500; line-height: 22px; margin: 0 0 8px; }
.pawwork-automation-run { align-items: center; display: flex; gap: 10px; justify-content: space-between; min-height: 44px; }
.pawwork-automation-run-main { flex: 1; min-width: 0; }
.pawwork-automation-run > button { flex: 0 0 auto; white-space: nowrap; }
.pawwork-automation-run-state { font-size: 12px; font-weight: 500; margin-left: 8px; }
.pawwork-automation-run-time, .pawwork-automation-run-summary { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.pawwork-automation-run-time { margin-left: 8px; }
.pawwork-automation-run-summary {
  display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
@media (max-width: 900px) {
  .pawwork-automations-surface[data-split="true"] .pawwork-automations-main { display: none; }
  .pawwork-automation-panel { padding-inline: 20px; }
  .pawwork-automation-group { grid-template-columns: 1fr; gap: 8px; }
}
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

    function createAutomationSurfaceController() {
      let registrar = null
      let disposeSurface = null
      let opened = false
      const listeners = new Set()
      const notify = () => listeners.forEach((listener) => listener(opened))
      return {
        attach(nextRegistrar) {
          registrar = nextRegistrar
          if (opened && disposeSurface === null) disposeSurface = registrar()
          return () => {
            if (registrar !== nextRegistrar) return
            disposeSurface?.()
            disposeSurface = null
            registrar = null
          }
        },
        close() {
          disposeSurface?.()
          disposeSurface = null
          if (!opened) return
          opened = false
          notify()
        },
        isOpen: () => opened,
        open() {
          if (opened) return
          opened = true
          disposeSurface = registrar?.() || null
          notify()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function automationCall(connection, endpoint, payload = {}, signal) {
      return connection.rpc.call("/pawwork-automations", endpoint, payload, signal).then((result) => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      })
    }

    function AutomationAction({ wide, controller }) {
      const [active, setActive] = useState(controller.isOpen())
      useEffect(() => controller.subscribe(setActive), [controller])
      const label = text("自动化", "Automations")
      return h("button", {
        "aria-label": label, className: "pawwork-automation-entry",
        "data-active": active ? "true" : "false", "data-wide": wide ? "true" : "false",
        onClick: () => active ? controller.close() : controller.open(), title: label, type: "button",
      }, icon(["M12 7v5l3 2m5.2-5A9 9 0 1 0 21 12", "M17 5h3.2v3.2"]),
      wide ? h("span", { className: "pawwork-automation-label" }, label) : null)
    }

    function workspaceName(cwd) {
      const parts = String(cwd).split(/[\\/]/).filter(Boolean)
      return parts.at(-1) || cwd
    }
    function formatTime(value) {
      if (value === null || value === undefined) return "—"
      return new Intl.DateTimeFormat(isChinese() ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    }
    function formatSchedule(definition) {
      if (definition.kind === "oneshot") return text(`单次 ${formatTime(definition.fireAt)}`, `Once ${formatTime(definition.fireAt)}`)
      if (definition.rhythm.kind === "interval") {
        const minutes = definition.rhythm.everyMs / 60_000
        if (Number.isInteger(minutes / 60)) return text(`每 ${minutes / 60} 小时`, `Every ${minutes / 60}h`)
        return text(`每 ${minutes} 分钟`, `Every ${minutes}m`)
      }
      const [minute, hour, day, month, weekday] = definition.rhythm.expression.split(/\s+/)
      const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      const simpleTime = /^\d+$/.test(hour) && /^\d+$/.test(minute)
      if (simpleTime && day === "*" && month === "*" && weekday === "*") return text(`每天 ${clock}`, `Daily ${clock}`)
      if (simpleTime && day === "*" && month === "*" && weekday === "1-5") return text(`工作日 ${clock}`, `Weekdays ${clock}`)
      return `Cron ${definition.rhythm.expression}`
    }
    function runState(run) {
      const labels = isChinese()
        ? { failed: "失败", running: "运行中", stopped: "已停止", succeeded: "已完成" }
        : { failed: "Failed", running: "Running", stopped: "Stopped", succeeded: "Completed" }
      return labels[run.state] || run.state
    }
    function runDotState(run) {
      if (run.state === "failed") return "error"
      if (run.state === "running") return "ongoing"
      if (run.state === "stopped") return "warning"
      return "done"
    }

    function RunRow({ run, sessions, close }) {
      const summary = run.error || run.stopReason || run.result
      return h("div", { className: "pawwork-automation-run" },
        h("div", { className: "pawwork-automation-run-main" },
          h(StateDot, { size: 10, state: runDotState(run) }),
          h("span", { className: "pawwork-automation-run-state" }, runState(run)),
          h("span", { className: "pawwork-automation-run-time" }, formatTime(run.triggeredAt)),
          summary ? h("span", { className: "pawwork-automation-run-summary" }, summary) : null),
        run.sessionId ? h(Button, { onClick: () => { sessions.open(run.sessionId); close() }, size: "sm", variant: "outline" }, text("打开会话", "Open session")) : null)
    }

    function localDateTime(value) {
      const date = new Date(value)
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      return local.toISOString().slice(0, 16)
    }
    function scheduleForm(definition) {
      const base = { time: "09:00", weekday: "1", intervalMinutes: "60", cron: "0 9 * * *", at: localDateTime(Date.now() + 3_600_000) }
      if (definition.kind === "oneshot") return { ...base, frequency: "once", at: localDateTime(definition.fireAt) }
      if (definition.rhythm.kind === "interval") return { ...base, frequency: "interval", intervalMinutes: String(definition.rhythm.everyMs / 60_000) }
      const [minute, hour, day, month, weekday] = definition.rhythm.expression.split(/\s+/)
      const timeValue = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      const simpleTime = /^\d+$/.test(hour) && /^\d+$/.test(minute)
      if (simpleTime && day === "*" && month === "*" && weekday === "*") return { ...base, frequency: "daily", time: timeValue, cron: definition.rhythm.expression }
      if (simpleTime && day === "*" && month === "*" && weekday === "1-5") return { ...base, frequency: "weekdays", time: timeValue, cron: definition.rhythm.expression }
      if (simpleTime && day === "*" && month === "*" && /^[0-6]$/.test(weekday)) return { ...base, frequency: "weekly", time: timeValue, weekday, cron: definition.rhythm.expression }
      return { ...base, frequency: "cron", cron: definition.rhythm.expression }
    }
    function formState(definition) {
      return {
        ...scheduleForm(definition), title: definition.title, prompt: definition.prompt, cwd: definition.cwd,
        provider: definition.model.provider, model: definition.model.model, timezone: definition.timezone,
        context: definition.context,
        runCount: definition.stop?.kind === "count" ? String(definition.stop.count) : "",
      }
    }
    function schedulePayload(form) {
      if (form.frequency === "once") {
        const fireAt = new Date(form.at).getTime()
        if (!Number.isFinite(fireAt) || fireAt <= Date.now()) throw new Error(text("运行时间必须在未来", "Run time must be in the future"))
        return { kind: "oneshot", fireAt }
      }
      if (form.frequency === "interval") {
        const everyMs = Number(form.intervalMinutes) * 60_000
        if (!Number.isSafeInteger(everyMs) || everyMs < 30_000) throw new Error(text("间隔至少为 30 秒", "Interval must be at least 30 seconds"))
        return { kind: "recurring", rhythm: { kind: "interval", everyMs } }
      }
      let expression = form.cron
      if (["daily", "weekdays", "weekly"].includes(form.frequency)) {
        const [hour, minute] = form.time.split(":").map(Number)
        if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error(text("请选择运行时间", "Choose a run time"))
        const weekday = form.frequency === "daily" ? "*" : form.frequency === "weekdays" ? "1-5" : form.weekday
        expression = `${minute} ${hour} * * ${weekday}`
      }
      return { kind: "recurring", rhythm: { kind: "cron", expression } }
    }
    function Field({ label, multiline = false, children }) {
      return h("div", { className: "pawwork-automation-group", "data-multiline": multiline ? "true" : "false" }, h("span", { className: "pawwork-automation-group-label" }, label), children)
    }
    function SelectControl({ disabled = false, label, onChange, options, value }) {
      const [open, setOpen] = useState(false)
      const selected = options.find((option) => option[0] === value)
      const anchor = h(Button, {
        "aria-label": label, className: "pawwork-automation-select-trigger", disabled,
        onClick: () => setOpen((current) => !current), size: "md", type: "button", variant: "ghost",
      }, h("span", null, selected?.[1] || value), h(IconChevronDownOutline14, { size: 14 }))
      return h(Menu, {
        align: "end", anchor, compact: true, items: options.map(([id, optionLabel]) => ({ id, label: optionLabel })),
        onClose: () => setOpen(false), onSelect: (id) => { onChange(id); setOpen(false) }, open,
        portal: true, selectedId: value,
      })
    }

    function AutomationEditor({ connection, definition, onClose, onDeleted, onSaved, sessions, workspaces }) {
      const baseline = useRef(formState(definition))
      const [form, setForm] = useState(baseline.current)
      const [busy, setBusy] = useState("")
      const [error, setError] = useState("")
      const [discarding, setDiscarding] = useState(false)
      const [deleting, setDeleting] = useState(false)
      const [advanced, setAdvanced] = useState(false)
      const dirty = JSON.stringify(form) !== JSON.stringify(baseline.current)
      const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }))
      const choose = (field) => (value) => setForm((current) => ({ ...current, [field]: value }))

      async function save(event) {
        event.preventDefault()
        setBusy("save")
        setError("")
        try {
          if (!form.title.trim() || !form.prompt.trim() || !form.cwd || !form.provider.trim() || !form.model.trim()) {
            throw new Error(text("请填写标题、任务内容、工作区和模型", "Complete title, prompt, workspace, and model"))
          }
          const schedule = schedulePayload(form)
          const common = {
            title: form.title, prompt: form.prompt,
            model: { provider: form.provider, model: form.model }, timezone: form.timezone,
            ...(schedule.kind === "recurring" ? { stop: form.runCount ? { kind: "count", count: Number(form.runCount) } : { kind: "never" } } : {}),
          }
          const result = await automationCall(connection, "update", { id: definition.id, ...common, ...(schedule.kind === "oneshot" ? { fireAt: schedule.fireAt } : { rhythm: schedule.rhythm }) })
          onSaved(result)
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : String(saveError))
        } finally { setBusy("") }
      }
      function requestClose() {
        if (!dirty) return onClose()
        setDiscarding(true)
      }
      async function mutate(endpoint, payload) {
        setBusy(endpoint)
        setError("")
        try {
          const result = await automationCall(connection, endpoint, payload)
          onSaved(endpoint === "run-now" ? definition : result)
        }
        catch (mutationError) { setError(mutationError instanceof Error ? mutationError.message : String(mutationError)) }
        finally { setBusy("") }
      }
      async function remove() {
        if (!deleting) return setDeleting(true)
        setBusy("delete")
        try { await automationCall(connection, "delete", { id: definition.id }); onDeleted() }
        catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : String(deleteError)) }
        finally { setBusy("") }
      }

      const scheduleOptions = definition.kind === "oneshot"
        ? [["once", text("单次", "Once")]]
        : [["daily", text("每天", "Daily")], ["weekdays", text("工作日", "Weekdays")], ["weekly", text("每周", "Weekly")], ["interval", text("固定间隔", "Interval")], ["cron", "Cron"]]
      const workspaceOptions = workspaces.map((workspace) => [workspace.path, workspace.title])
      const weekdayOptions = [["1", text("周一", "Monday")], ["2", text("周二", "Tuesday")], ["3", text("周三", "Wednesday")], ["4", text("周四", "Thursday")], ["5", text("周五", "Friday")], ["6", text("周六", "Saturday")], ["0", text("周日", "Sunday")]]
      return h("section", { className: "pawwork-automation-panel" }, h("div", { className: "pawwork-automation-panel-inner" },
        h("div", { className: "pawwork-automation-panel-head" },
          h("h2", null, definition.title),
          h("div", { className: "pawwork-automation-actions" },
            h(Button, { disabled: busy !== "", icon: h(definition.paused ? IconPlayOutline16 : IconPauseOutline16, { size: 16 }), onClick: () => mutate("set-paused", { id: definition.id, paused: !definition.paused }), size: "sm", variant: "outline" }, definition.paused ? text("启用", "Resume") : text("暂停", "Pause")),
            h(Button, { disabled: busy !== "", icon: h(IconPlayOutline16, { size: 16 }), onClick: () => mutate("run-now", { id: definition.id }), size: "sm", variant: "outline" }, text("立即运行", "Run now")),
            h(Button, { "aria-label": deleting ? text("确认删除", "Confirm delete") : text("删除", "Delete"), disabled: busy !== "", icon: h(IconTrashOutline16, { size: 16 }), onClick: remove, size: "sm", title: deleting ? text("再次点击确认删除", "Click again to confirm deletion") : text("删除", "Delete"), type: "button", variant: "ghost" }),
            h(Button, { "aria-label": text("关闭", "Close"), icon: h(IconCloseOutline16, { size: 16 }), onClick: requestClose, size: "sm", title: text("关闭", "Close"), type: "button", variant: "ghost" }))),
        h("form", { className: "pawwork-automation-form", onSubmit: save },
          h(Field, { label: text("标题", "Title") }, h(Input, { "aria-label": text("标题", "Title"), className: "pawwork-automation-input", onChange: update("title"), value: form.title })),
          h(Field, { label: text("任务内容", "Instructions"), multiline: true }, h("textarea", { "aria-label": text("任务内容", "Instructions"), className: "pawwork-automation-textarea", onChange: update("prompt"), value: form.prompt })),
          h(Field, { label: text("工作区", "Workspace") }, h(SelectControl, { disabled: true, label: text("工作区", "Workspace"), onChange: choose("cwd"), options: workspaceOptions, value: form.cwd })),
          h("div", { className: "pawwork-automation-grid" },
            h(Field, { label: text("重复", "Repeat") }, h(SelectControl, { label: text("重复", "Repeat"), onChange: choose("frequency"), options: scheduleOptions, value: form.frequency })),
            form.frequency === "once" ? h(Field, { label: text("运行时间", "Run time") }, h(Input, { "aria-label": text("运行时间", "Run time"), className: "pawwork-automation-input", onChange: update("at"), type: "datetime-local", value: form.at })) : null,
            ["daily", "weekdays", "weekly"].includes(form.frequency) ? h(Field, { label: text("时间", "Time") }, h(Input, { "aria-label": text("时间", "Time"), className: "pawwork-automation-input", onChange: update("time"), type: "time", value: form.time })) : null,
            form.frequency === "weekly" ? h(Field, { label: text("星期", "Weekday") }, h(SelectControl, { label: text("星期", "Weekday"), onChange: choose("weekday"), options: weekdayOptions, value: form.weekday })) : null,
            form.frequency === "interval" ? h(Field, { label: text("间隔分钟", "Interval minutes") }, h(Input, { "aria-label": text("间隔分钟", "Interval minutes"), className: "pawwork-automation-input", min: "0.5", onChange: update("intervalMinutes"), step: "0.5", type: "number", value: form.intervalMinutes })) : null,
            form.frequency === "cron" ? h(Field, { label: "Cron" }, h(Input, { "aria-label": "Cron", className: "pawwork-automation-input", onChange: update("cron"), value: form.cron })) : null),
          h("div", { className: "pawwork-automation-advanced" },
            h(DisclosureRow, { expandOnRowClick: true, expandable: true, icon: h(IconSettingsOutline16, { size: 16 }), onToggle: () => setAdvanced((current) => !current), open: advanced, title: text("高级设置", "Advanced settings") },
              h("div", { className: "pawwork-automation-advanced-content" },
                h(Field, { label: text("模型来源", "Provider") }, h(Input, { "aria-label": text("模型来源", "Provider"), className: "pawwork-automation-input", onChange: update("provider"), value: form.provider })),
                h(Field, { label: text("模型", "Model") }, h(Input, { "aria-label": text("模型", "Model"), className: "pawwork-automation-input", onChange: update("model"), value: form.model })),
                h(Field, { label: text("时区", "Timezone") }, h(Input, { "aria-label": text("时区", "Timezone"), className: "pawwork-automation-input", onChange: update("timezone"), value: form.timezone })),
                h(Field, { label: text("会话", "Session") }, h(SelectControl, { disabled: true, label: text("会话", "Session"), onChange: () => {}, options: [["fresh", text("每次新会话", "New session each run")], ["continue", text("继续原会话", "Continue original session")]], value: form.context })),
                form.frequency !== "once" ? h(Field, { label: text("运行次数上限", "Run limit") }, h(Input, { "aria-label": text("运行次数上限", "Run limit"), className: "pawwork-automation-input", min: "1", onChange: update("runCount"), placeholder: text("永不停止", "Never"), type: "number", value: form.runCount })) : null))),
          error ? h("div", { className: "pawwork-automations-error", role: "alert" }, error) : null,
          h("div", { className: "pawwork-automation-form-footer" },
            discarding ? h("span", { className: "pawwork-automation-discard" }, text("放弃未保存的更改？", "Discard unsaved changes?")) : null,
            discarding ? h(Button, { onClick: () => setDiscarding(false), size: "sm", type: "button", variant: "outline" }, text("继续编辑", "Keep editing")) : null,
            discarding ? h(Button, { onClick: onClose, size: "sm", type: "button", variant: "outline" }, text("放弃", "Discard")) : null,
            !discarding ? h(Button, { disabled: busy !== "" || !dirty, size: "sm", type: "submit", variant: "primary" }, text("保存", "Save")) : null)),
        h("div", { className: "pawwork-automation-history" },
          h("h3", null, text("最近运行", "Recent runs")),
          [definition.activeRun, ...(definition.recentRuns || [])].filter(Boolean).length
            ? [definition.activeRun, ...(definition.recentRuns || [])].filter(Boolean).map((run) => h(RunRow, { close: onClose, key: run.id, run, sessions }))
            : h("div", { className: "pawwork-automations-empty" }, text("还没有运行记录", "No run history yet")))))
    }

    function AutomationSurface({ connection, createViaChat, sessions, useWorkspaces }) {
      const workspaceState = useWorkspaces((state) => state)
      const workspaces = workspaceState.items || []
      const [data, setData] = useState(null)
      const [selectedId, setSelectedId] = useState(null)
      const [query, setQuery] = useState("")
      const [filter, setFilter] = useState("all")
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState("")

      async function load(signal) {
        setLoading(true)
        setError("")
        try {
          const list = await automationCall(connection, "list", {}, signal)
          setData(list)
          setSelectedId((current) => list.definitions.some((item) => item.id === current) ? current : null)
        } catch (loadError) {
          if (!signal?.aborted) setError(loadError instanceof Error ? loadError.message : String(loadError))
        } finally { if (!signal?.aborted) setLoading(false) }
      }
      useEffect(() => {
        const abort = new AbortController()
        let timer = null
        async function poll() {
          await load(abort.signal)
          if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 1_000)
        }
        void poll()
        return () => {
          abort.abort()
          if (timer !== null) clearTimeout(timer)
        }
      }, [])

      const definitions = data?.definitions || []
      const selected = definitions.find((definition) => definition.id === selectedId) || null
      const visible = definitions.filter((definition) => {
        if (filter === "active" && definition.paused) return false
        if (filter === "paused" && !definition.paused) return false
        const needle = query.trim().toLocaleLowerCase()
        return !needle || definition.title.toLocaleLowerCase().includes(needle) || workspaceName(definition.cwd).toLocaleLowerCase().includes(needle)
      })
      const split = selected !== null
      const preferredWorkspace = workspaces.find((item) => item.workspaceId === workspaceState.recentWorkspaceId) || workspaces[0]
      function closePanel() { setSelectedId(null) }
      async function reloadAfter(result) { await load(); setSelectedId(result.id) }
      async function createAutomation() {
        if (!preferredWorkspace) return
        setError("")
        try { await createViaChat(preferredWorkspace.workspaceId) }
        catch (createError) { setError(createError instanceof Error ? createError.message : String(createError)) }
      }

      return h("main", { className: "pawwork-automations-surface", "data-split": split ? "true" : "false" },
        h("section", { className: "pawwork-automations-main" }, h("div", { className: "pawwork-automations-overview" },
          h("div", { className: "pawwork-automations-titlebar" },
            h("div", null, h("h1", null, text("自动化", "Automations")), h("p", null, text("让 PawWork 按计划处理重复工作", "Let PawWork handle recurring work on a schedule"))),
            h("div", { className: "pawwork-automations-title-actions" },
              h(Button, { disabled: !preferredWorkspace, onClick: createAutomation, size: "sm", title: text("在对话中创建", "Create in chat"), variant: "primary" }, text("新建", "New")))),
          h(Input, { "aria-label": text("搜索自动化", "Search automations"), className: "pawwork-automations-search", icon: h(IconSearchOutline16, { size: 16 }), onChange: (event) => setQuery(event.target.value), placeholder: text("搜索自动化", "Search automations"), value: query }),
          h("div", { className: "pawwork-automations-tabs", role: "tablist" }, [["all", text("全部", "All")], ["active", text("启用", "Active")], ["paused", text("暂停", "Paused")]].map(([value, label]) => h(Pill, { active: filter === value, key: value, onClick: () => setFilter(value), role: "tab" }, label))),
          error ? h("div", { className: "pawwork-automations-error", role: "alert" }, error) : null,
          loading && data === null ? h("div", { className: "pawwork-automations-loading" }, text("正在加载…", "Loading…")) : null,
          visible.map((definition) => h("button", { className: "pawwork-automation-row", "data-selected": definition.id === selectedId ? "true" : "false", key: definition.id, onClick: () => setSelectedId(definition.id), type: "button" },
            h("span", { className: "pawwork-automation-row-icon" }, h(definition.paused ? IconPauseOutline16 : IconPlayOutline16, { size: 16 })),
            h("span", null, h("span", { className: "pawwork-automation-row-title" }, definition.title), h("span", { className: "pawwork-automation-row-meta" }, `${formatSchedule(definition)}  ${definition.paused ? text("已暂停", "Paused") : `${text("下次", "Next")} ${formatTime(definition.nextFireAt)}`}`)))),
          visible.length === 0 && !loading ? h("div", { className: "pawwork-automations-empty" }, query ? text("没有匹配的自动化", "No matching automations") : text("还没有自动化", "No automations yet")) : null)),
        split ? h(AutomationEditor, { connection, definition: selected, key: `${selected.id}:${selected.revision}`, onClose: closePanel, onDeleted: async () => { closePanel(); await load() }, onSaved: reloadAfter, sessions, workspaces }) : null)
    }

    const inject = ["slots", "layout", "connection", "conversation", "sessions", "workspaces"]
    function apply(ctx) {
      document.title = "PawWork"
      const automationSurface = createAutomationSurfaceController()
      ctx.slots.inject("settings.onboarding", () => ctx.slots.register({ name: "settings.onboarding", id: "welcome-notice", order: -100, priority: -1 }, CompleteWelcomeNotice))
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "pawwork-files", order: -100 }, FileAction))
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "pawwork-sidebar-toggle", order: -100 }, () => SidebarToggle({ toggleSidebar: () => ctx.layout.toggleSidebar() })))
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "pawwork-v1-migration-refresh", order: -99 }, () => h(CompleteV1MigrationRefresh, { connection: ctx.connection, sessions: ctx.sessions })))
      ctx.slots.inject("conversation", () => automationSurface.attach(() => {
        ctx.layout.closeDetails()
        return ctx.slots.register({ name: "conversation", priority: -100 }, (props) => h(AutomationSurface, {
          ...props, connection: ctx.connection,
          createViaChat: async (workspaceId) => {
            const sessionId = await ctx.workspaces.connectWorkspace(workspaceId)
            const binding = ctx.sessions.binding(sessionId)
            if (!binding) throw new Error("automation chat session is unavailable")
            ctx.conversation.input.for(binding.ctx).setDraft(text("帮我创建一个自动化。先问我它要做什么、什么时候运行，再帮我创建。", "Help me create an automation. Ask what it should do and when it should run, then create it."))
            ctx.sessions.open(sessionId)
            automationSurface.close()
          },
          sessions: ctx.sessions,
        }))
      }))
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "pawwork-automations", order: -100 }, ({ wide }) => AutomationAction({ controller: automationSurface, wide })))
    }

    return { inject, apply }
  },
})
