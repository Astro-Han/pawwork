window.__ModuleLoader__.load({
  id: "@pawwork/dsh-automations",
  factory: (require) => {
    const { createElement, useEffect, useRef, useState } = require("react")
    const {
      Button,
      DisclosureRow,
      Input,
      Menu,
      Modal,
      Pill,
      StateDot,
      IconChevronLeftOutline14,
      IconChevronDownOutline14,
      IconPauseOutline16,
      IconPlayOutline16,
      IconSearchOutline16,
      IconSettingsOutline16,
      IconTrashOutline16,
    } = require("@deepseek-ai/dsh-client-ui-primitives")
    const h = createElement

    const automationCss = `
.pawwork-automations-surface {
  color: var(--dsw-alias-label-primary); display: flex; flex-direction: column;
  gap: 12px; max-width: 720px; min-width: 0; width: 100%;
}
.pawwork-automations-titlebar {
  align-items: flex-start; display: flex; gap: 20px; justify-content: space-between; margin-bottom: 20px;
}
.pawwork-automations-titlebar h1 {
  font-size: 16px; font-weight: 500; line-height: 24px; margin: 0;
}
.pawwork-automations-titlebar p {
  color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 22px; margin: 0;
}
.pawwork-automations-title-actions { align-items: center; display: flex; flex: none; gap: 8px; }
.pawwork-automations-search, .pawwork-automations-search input { width: 100%; }
.pawwork-automations-tabs { display: flex; gap: 6px; }
.pawwork-automations-list { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.pawwork-automation-row {
  align-items: center; background: transparent; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  color: inherit; display: grid; font: inherit; gap: 10px;
  grid-template-columns: 20px minmax(0, 1fr); min-height: 62px;
  padding: 10px 14px; text-align: left; width: 100%;
}
.pawwork-automation-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pawwork-automation-row:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.pawwork-automation-row-icon { color: var(--dsw-alias-label-secondary); display: inline-flex; }
.pawwork-automation-row-title, .pawwork-automation-row-meta {
  display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pawwork-automation-row-title { font-size: 14px; font-weight: 500; line-height: 22px; }
.pawwork-automation-row-meta { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.pawwork-automations-empty, .pawwork-automations-loading {
  border: 1px dashed var(--dsw-alias-border-l3); border-radius: 8px;
  color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; padding: 20px; text-align: center;
}
.pawwork-automations-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; margin: 12px 0; }
.pawwork-automation-panel { min-width: 0; width: 100%; }
.pawwork-automation-panel-inner { display: flex; flex-direction: column; gap: 12px; width: 100%; }
.pawwork-automation-back { align-self: flex-start; margin-left: -8px; }
.pawwork-automation-panel-head {
  align-items: flex-start; display: flex; flex-wrap: wrap; gap: 12px 16px; justify-content: space-between;
}
.pawwork-automation-panel-head > div:first-child { flex: 1 1 240px; min-width: 0; }
.pawwork-automation-panel-head h2 { font-size: 16px; font-weight: 500; line-height: 24px; margin: 0; }
.pawwork-automation-panel-head h2 { overflow-wrap: anywhere; }
.pawwork-automation-panel-summary { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; margin: 2px 0 0; overflow-wrap: anywhere; }
.pawwork-automation-actions { align-items: center; display: flex; flex: none; gap: 6px; }
.pawwork-automation-delete-confirm { color: var(--dsw-alias-state-error-primary); }
.pawwork-automation-form {
  background: var(--dsw-alias-bg-module-platform); border-radius: 12px;
  display: flex; flex-direction: column; gap: 14px; padding: 14px 16px;
}
.pawwork-automation-group {
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
}
.pawwork-automation-group-label { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.pawwork-automation-input, .pawwork-automation-input input { width: 100%; }
.pawwork-automation-readonly { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.pawwork-automation-textarea {
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; box-sizing: border-box; color: var(--dsw-alias-label-primary); font: inherit;
  font-size: 14px; line-height: 22px; min-height: 116px; padding: 9px 10px; resize: vertical; width: 100%;
}
.pawwork-automation-textarea:focus { border-color: var(--dsw-alias-brand-primary); outline: none; }
.pawwork-automation-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
.pawwork-automation-select-trigger { justify-content: space-between; max-width: 100%; min-width: 148px; }
.pawwork-automation-select-trigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pawwork-automation-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.pawwork-automation-advanced { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 4px; }
.pawwork-automation-advanced-content { border-top: 1px solid var(--dsw-alias-border-l2); display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-top: 10px; padding-top: 12px; }
.pawwork-automation-form-footer {
  align-items: center; display: flex; gap: 8px; justify-content: flex-end;
}
.pawwork-automation-discard { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-right: auto; }
.pawwork-automation-history {
  border-top: 1px solid var(--dsw-alias-border-l2); margin-top: 4px; padding-top: 14px;
}
.pawwork-automation-history h3 { font-size: 14px; font-weight: 500; line-height: 22px; margin: 0 0 8px; }
.pawwork-automation-run { align-items: center; display: flex; gap: 10px; justify-content: space-between; min-height: 44px; padding: 4px 0; }
.pawwork-automation-run-main { flex: 1; min-width: 0; }
.pawwork-automation-run > button { flex: 0 0 auto; white-space: nowrap; }
.pawwork-automation-run-state { font-size: 12px; font-weight: 500; margin-left: 8px; }
.pawwork-automation-run-time, .pawwork-automation-run-summary { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.pawwork-automation-run-time { margin-left: 8px; }
.pawwork-automation-run-summary {
  display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
@media (max-width: 680px) {
  .pawwork-automations-titlebar, .pawwork-automation-panel-head { flex-direction: column; }
  .pawwork-automation-actions { flex-wrap: wrap; }
  .pawwork-automation-grid, .pawwork-automation-advanced-content { grid-template-columns: 1fr; }
}
`

    const styleId = "@pawwork/dsh-automations"
    if (document.querySelector(`style[data-plugin-css="${styleId}"]`) === null) {
      const style = document.createElement("style")
      style.dataset.plugin = "@pawwork/dsh-automations"
      style.dataset.pluginCss = styleId
      style.textContent = automationCss
      document.head.appendChild(style)
    }
    function isChinese() { return document.documentElement.lang.startsWith("zh") }
    function text(chinese, english) { return isChinese() ? chinese : english }

    // Editor order: the week starts on Monday in the select, and Sunday is cron 0.
    const WEEKDAYS = [["1", "周一", "Monday"], ["2", "周二", "Tuesday"], ["3", "周三", "Wednesday"], ["4", "周四", "Thursday"], ["5", "周五", "Friday"], ["6", "周六", "Saturday"], ["0", "周日", "Sunday"]]

    // One statement of which cron expressions the editor's presets round-trip.
    // The list label read it, the editor form read it, and the save path wrote
    // it, each with its own copy — and they had drifted: the form recognised a
    // weekly expression it had written itself while the label showed raw cron.
    function cronPreset(expression) {
      const [minute, hour, day, month, weekday] = String(expression).split(/\s+/)
      if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute) || day !== "*" || month !== "*") return null
      const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
      if (weekday === "*") return { frequency: "daily", time }
      if (weekday === "1-5") return { frequency: "weekdays", time }
      if (WEEKDAYS.some(([value]) => value === weekday)) return { frequency: "weekly", time, weekday }
      return null
    }

    function presetCron({ frequency, time, weekday }) {
      const [hour, minute] = String(time).split(":").map(Number)
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
      return `${minute} ${hour} * * ${frequency === "daily" ? "*" : frequency === "weekdays" ? "1-5" : weekday}`
    }

    function automationCall(connection, endpoint, payload = {}, signal) {
      return connection.rpc.call("/pawwork-automations", endpoint, payload, signal).then((result) => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      })
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
      const preset = cronPreset(definition.rhythm.expression)
      if (preset?.frequency === "daily") return text(`每天 ${preset.time}`, `Daily ${preset.time}`)
      if (preset?.frequency === "weekdays") return text(`工作日 ${preset.time}`, `Weekdays ${preset.time}`)
      if (preset?.frequency === "weekly") {
        const [, chinese, english] = WEEKDAYS.find(([value]) => value === preset.weekday)
        return text(`每${chinese} ${preset.time}`, `${english}s ${preset.time}`)
      }
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

    function RunRow({ onError, run, sessions, closeSettings }) {
      const summary = run.error || run.stopReason || run.result
      async function openSession() {
        try {
          await sessions.refresh()
          sessions.open(run.sessionId)
          closeSettings()
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error))
        }
      }
      return h("div", { className: "pawwork-automation-run" },
        h("div", { className: "pawwork-automation-run-main" },
          h(StateDot, { size: 10, state: runDotState(run) }),
          h("span", { className: "pawwork-automation-run-state" }, runState(run)),
          h("span", { className: "pawwork-automation-run-time" }, formatTime(run.triggeredAt)),
          summary ? h("span", { className: "pawwork-automation-run-summary" }, summary) : null),
        run.sessionId ? h(Button, { onClick: openSession, size: "sm", variant: "outline" }, text("打开会话", "Open session")) : null)
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
      const preset = cronPreset(definition.rhythm.expression)
      if (preset) return { ...base, ...preset, cron: definition.rhythm.expression }
      return { ...base, frequency: "cron", cron: definition.rhythm.expression }
    }
    function formState(definition) {
      return {
        ...scheduleForm(definition), title: definition.title, prompt: definition.prompt,
        provider: definition.model.provider, model: definition.model.model, timezone: definition.timezone,
        runCount: definition.stop?.kind === "count" ? String(definition.stop.count) : "",
      }
    }
    function stopPayload(runCount) {
      const trimmed = String(runCount).trim()
      if (!trimmed) return { kind: "never" }
      const count = Number(trimmed)
      // "0" is truthy as a string, so an empty check let it through and the user
      // met the backend's untranslated "run_count must be a positive integer".
      if (!Number.isSafeInteger(count) || count < 1) throw new Error(text("运行次数至少为 1", "Run count must be at least 1"))
      return { kind: "count", count }
    }

    function schedulePayload(form) {
      if (form.frequency === "once") {
        const fireAt = new Date(form.at).getTime()
        if (!Number.isFinite(fireAt) || fireAt <= Date.now()) throw new Error(text("运行时间必须在未来", "Run time must be in the future"))
        return { kind: "oneshot", fireAt }
      }
      if (form.frequency === "interval") {
        const everyMs = Number(form.intervalMinutes) * 60_000
        // Mirrors MIN_INTERVAL_MS in automations.cjs. The renderer cannot require
        // the backend module, so a test pins the two together; without this the
        // user would meet the backend's untranslated error instead.
        if (!Number.isSafeInteger(everyMs) || everyMs < 30_000) throw new Error(text("间隔至少为 30 秒", "Interval must be at least 30 seconds"))
        return { kind: "recurring", rhythm: { kind: "interval", everyMs } }
      }
      let expression = form.cron
      if (["daily", "weekdays", "weekly"].includes(form.frequency)) {
        expression = presetCron(form)
        if (!expression) throw new Error(text("请选择运行时间", "Choose a run time"))
      }
      return { kind: "recurring", rhythm: { kind: "cron", expression } }
    }
    function Field({ label, children }) {
      return h("div", { className: "pawwork-automation-group" }, h("span", { className: "pawwork-automation-group-label" }, label), children)
    }
    function SelectControl({ label, onChange, options, value }) {
      const [open, setOpen] = useState(false)
      const selected = options.find((option) => option[0] === value)
      const anchor = h(Button, {
        "aria-label": label, className: "pawwork-automation-select-trigger",
        onClick: () => setOpen((current) => !current), size: "md", type: "button", variant: "ghost",
      }, h("span", null, selected?.[1] || value), h(IconChevronDownOutline14, { size: 14 }))
      return h(Menu, {
        align: "end", anchor, compact: true, items: options.map(([id, optionLabel]) => ({ id, label: optionLabel })),
        onClose: () => setOpen(false), onSelect: (id) => { onChange(id); setOpen(false) }, open,
        portal: true, selectedId: value,
      })
    }

    function AutomationEditor({ closeSettings, connection, definition, onClose, onDeleted, onSaved, sessions }) {
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
          if (!form.title.trim() || !form.prompt.trim() || !form.provider.trim() || !form.model.trim()) {
            throw new Error(text("请填写标题、任务内容和模型", "Complete title, prompt, and model"))
          }
          const schedule = schedulePayload(form)
          const common = {
            title: form.title, prompt: form.prompt,
            model: { provider: form.provider, model: form.model }, timezone: form.timezone,
            ...(schedule.kind === "recurring" ? { stop: stopPayload(form.runCount) } : {}),
          }
          const result = await automationCall(connection, "update", { id: definition.id, expectedRevision: definition.revision, ...common, ...(schedule.kind === "oneshot" ? { fireAt: schedule.fireAt } : { rhythm: schedule.rhythm }) })
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
        setBusy("delete")
        try { await automationCall(connection, "delete", { id: definition.id }); onDeleted() }
        catch (deleteError) {
          setDeleting(false)
          setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
        }
        finally { setBusy("") }
      }

      const scheduleOptions = definition.kind === "oneshot"
        ? [["once", text("单次", "Once")]]
        : [["daily", text("每天", "Daily")], ["weekdays", text("工作日", "Weekdays")], ["weekly", text("每周", "Weekly")], ["interval", text("固定间隔", "Interval")], ["cron", "Cron"]]
      const weekdayOptions = WEEKDAYS.map(([value, chinese, english]) => [value, text(chinese, english)])
      return h("section", { className: "pawwork-automation-panel" }, h("div", { className: "pawwork-automation-panel-inner" },
        h(Button, { className: "pawwork-automation-back", icon: h(IconChevronLeftOutline14, { size: 14 }), onClick: requestClose, size: "sm", type: "button", variant: "ghost" }, text("返回自动化", "Back to Automations")),
        h("div", { className: "pawwork-automation-panel-head" },
          h("div", null,
            h("h2", null, definition.title),
            h("p", { className: "pawwork-automation-panel-summary" }, `${formatSchedule(definition)}  ${workspaceName(definition.cwd)}`)),
          h("div", { className: "pawwork-automation-actions" },
            h(Button, { disabled: busy !== "" || dirty, icon: h(definition.paused ? IconPlayOutline16 : IconPauseOutline16, { size: 16 }), onClick: () => mutate("set-paused", { id: definition.id, paused: !definition.paused }), size: "sm", title: dirty ? text("请先保存更改", "Save changes first") : undefined, variant: "outline" }, definition.paused ? text("启用", "Resume") : text("暂停", "Pause")),
            h(Button, { disabled: busy !== "", icon: h(IconPlayOutline16, { size: 16 }), onClick: () => mutate("run-now", { id: definition.id }), size: "sm", variant: "primary" }, text("立即运行", "Run now")),
            h(Button, { "aria-label": text("删除", "Delete"), disabled: busy !== "", icon: h(IconTrashOutline16, { size: 16 }), onClick: () => setDeleting(true), size: "sm", title: text("删除", "Delete"), type: "button", variant: "ghost" }))),
        h("form", { className: "pawwork-automation-form", onSubmit: save },
          h(Field, { label: text("标题", "Title") }, h(Input, { "aria-label": text("标题", "Title"), className: "pawwork-automation-input", onChange: update("title"), value: form.title })),
          h(Field, { label: text("任务内容", "Instructions") }, h("textarea", { "aria-label": text("任务内容", "Instructions"), className: "pawwork-automation-textarea", onChange: update("prompt"), value: form.prompt })),
          h(Field, { label: text("工作区", "Workspace") }, h("span", { className: "pawwork-automation-readonly", title: definition.cwd }, workspaceName(definition.cwd))),
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
                h(Field, { label: text("会话", "Session") }, h("span", { className: "pawwork-automation-readonly" }, definition.context === "continue" ? text("继续原会话", "Continue original session") : text("每次新会话", "New session each run"))),
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
            ? [definition.activeRun, ...(definition.recentRuns || [])].filter(Boolean).map((run) => h(RunRow, { closeSettings, key: run.id, onError: setError, run, sessions }))
            : h("div", { className: "pawwork-automations-empty" }, text("还没有运行记录", "No run history yet")))),
        h(Modal, {
          closeLabel: text("关闭", "Close"),
          description: text("此操作无法撤销。既有运行记录会保留。", "This cannot be undone. Existing run history is retained."),
          footer: h("div", { className: "pawwork-automation-actions" },
            h(Button, { autoFocus: true, disabled: busy === "delete", onClick: () => setDeleting(false), size: "sm", variant: "outline" }, text("取消", "Cancel")),
            h(Button, { className: "pawwork-automation-delete-confirm", disabled: busy === "delete", onClick: remove, size: "sm", variant: "outline" }, busy === "delete" ? text("正在删除…", "Deleting…") : text("删除", "Delete"))),
          onClose: () => { if (busy !== "delete") setDeleting(false) },
          open: deleting,
          title: text("删除自动化？", "Delete automation?"),
        }))
    }

    function AutomationSurface({ close, connection, createViaChat, sessions, useWorkspaces }) {
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
      const preferredWorkspace = workspaces.find((item) => item.workspaceId === workspaceState.recentWorkspaceId) || workspaces[0]
      function closePanel() { setSelectedId(null) }
      async function reloadAfter(result) { await load(); setSelectedId(result.id) }
      async function createAutomation() {
        if (!preferredWorkspace) return
        setError("")
        try { await createViaChat(preferredWorkspace.workspaceId) }
        catch (createError) { setError(createError instanceof Error ? createError.message : String(createError)) }
      }

      if (selected) return h("main", { className: "pawwork-automations-surface" },
        h(AutomationEditor, { closeSettings: close, connection, definition: selected, key: `${selected.id}:${selected.revision}`, onClose: closePanel, onDeleted: async () => { closePanel(); await load() }, onSaved: reloadAfter, sessions }))

      return h("main", { className: "pawwork-automations-surface" },
          h("div", { className: "pawwork-automations-titlebar" },
            h("div", null, h("h1", null, text("自动化", "Automations")), h("p", null, text("让 PawWork 按计划处理重复工作", "Let PawWork handle recurring work on a schedule"))),
            h("div", { className: "pawwork-automations-title-actions" },
              h(Button, { disabled: !preferredWorkspace, onClick: createAutomation, size: "sm", variant: "primary" }, text("在对话中创建", "Create in chat")))),
          h(Input, { "aria-label": text("搜索自动化", "Search automations"), className: "pawwork-automations-search", icon: h(IconSearchOutline16, { size: 16 }), onChange: (event) => setQuery(event.target.value), placeholder: text("搜索自动化", "Search automations"), value: query }),
          h("div", { className: "pawwork-automations-tabs", role: "tablist" }, [["all", text("全部", "All")], ["active", text("启用", "Active")], ["paused", text("暂停", "Paused")]].map(([value, label]) => h(Pill, { active: filter === value, key: value, onClick: () => setFilter(value), role: "tab" }, label))),
          error ? h("div", { className: "pawwork-automations-error", role: "alert" }, error) : null,
          loading && data === null ? h("div", { className: "pawwork-automations-loading" }, text("正在加载…", "Loading…")) : null,
          h("div", { className: "pawwork-automations-list" },
            visible.map((definition) => h("button", { className: "pawwork-automation-row", key: definition.id, onClick: () => setSelectedId(definition.id), type: "button" },
              h("span", { className: "pawwork-automation-row-icon" }, h(definition.paused ? IconPauseOutline16 : IconPlayOutline16, { size: 16 })),
              h("span", null, h("span", { className: "pawwork-automation-row-title" }, definition.title), h("span", { className: "pawwork-automation-row-meta" }, `${formatSchedule(definition)}  ${definition.paused ? text("已暂停", "Paused") : `${text("下次", "Next")} ${formatTime(definition.nextFireAt)}`}`)))),
            visible.length === 0 && !loading ? h("div", { className: "pawwork-automations-empty" }, query ? text("没有匹配的自动化", "No matching automations") : text("还没有自动化。在对话中描述任务和运行时间即可创建。", "No automations yet. Describe a task and schedule in chat to create one.")) : null))
    }

    const inject = ["slots", "connection", "conversation", "sessions", "workspaces"]

    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "pawwork-automations", order: 40,
        label: () => text("自动化", "Automations"),
      }, (props) => h(AutomationSurface, {
          ...props, connection: ctx.connection,
          createViaChat: async (workspaceId) => {
            const sessionId = await ctx.workspaces.connectWorkspace(workspaceId)
            const binding = ctx.sessions.binding(sessionId)
            if (!binding) throw new Error("automation chat session is unavailable")
            ctx.conversation.input.for(binding.ctx).setDraft(text("帮我创建一个自动化。先问我它要做什么、什么时候运行，再帮我创建。", "Help me create an automation. Ask what it should do and when it should run, then create it."))
            ctx.sessions.open(sessionId)
            props.close()
          },
          sessions: ctx.sessions,
        })))
    }

    return { inject, apply }
  },
})
