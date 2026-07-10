import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { batch, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk/v2/client"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { joinCommand, splitCommand } from "@/components/mcp-command"

type McpConfig = McpLocalConfig | McpRemoteConfig

type KvRow = { key: string; value: string }

type Props = {
  mode: "add" | "edit"
  name?: string
  config?: McpConfig
  // Names already configured globally, used to reject duplicates on add / rename.
  existingNames: string[]
}

function recordToRows(record: Record<string, string> | undefined): KvRow[] {
  const rows = Object.entries(record ?? {}).map(([key, value]) => ({ key, value }))
  return rows.length ? rows : [{ key: "", value: "" }]
}

function rowsToRecord(rows: KvRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = row.value
  }
  return Object.keys(out).length ? out : undefined
}

export function DialogMcpForm(props: Props) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const language = useLanguage()

  const initial = props.config
  const initialType = initial?.type === "remote" ? "remote" : "local"

  const [form, setForm] = createStore({
    type: initialType as "local" | "remote",
    name: props.name ?? "",
    command: initial?.type === "local" ? joinCommand(initial.command) : "",
    url: initial?.type === "remote" ? initial.url : "",
    env: recordToRows(initial?.type === "local" ? initial.environment : undefined),
    headers: recordToRows(initial?.type === "remote" ? initial.headers : undefined),
    confirmingDelete: false,
    err: {} as { name?: string; command?: string; url?: string },
  })

  const isEdit = props.mode === "edit"

  const addRow = (field: "env" | "headers") =>
    setForm(field, produce((rows) => rows.push({ key: "", value: "" })))
  const removeRow = (field: "env" | "headers", index: number) =>
    setForm(field, produce((rows) => rows.length > 1 && rows.splice(index, 1)))
  const setRow = (field: "env" | "headers", index: number, key: "key" | "value", value: string) =>
    setForm(field, index, key, value)

  const validate = () => {
    const err: { name?: string; command?: string; url?: string } = {}
    const name = form.name.trim()
    if (!name) err.name = language.t("settings.mcp.error.name.required")
    else if (name !== props.name && props.existingNames.includes(name))
      err.name = language.t("settings.mcp.error.name.duplicate", { name })
    if (form.type === "local" && splitCommand(form.command).length === 0)
      err.command = language.t("settings.mcp.error.command.required")
    if (form.type === "remote" && !form.url.trim()) err.url = language.t("settings.mcp.error.url.required")
    setForm("err", err)
    return Object.keys(err).length === 0
  }

  const buildConfig = (): McpConfig => {
    // Preserve advanced fields the form does not expose (enabled / timeout, and
    // remote oauth) so hand-edited config survives an edit round-trip.
    const enabled = initial?.enabled
    const timeout = initial?.timeout
    const common = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    }
    if (form.type === "local") {
      const command = splitCommand(form.command)
      const environment = rowsToRecord(form.env)
      return { type: "local", command, ...(environment ? { environment } : {}), ...common }
    }
    const headers = rowsToRecord(form.headers)
    // Preserve oauth as-is, including an explicit `false` (which disables OAuth
    // auto-detection) — a truthy check would silently drop it and re-enable it.
    const oauth = initial?.type === "remote" ? initial.oauth : undefined
    return {
      type: "remote",
      url: form.url.trim(),
      ...(headers ? { headers } : {}),
      ...(oauth !== undefined ? { oauth } : {}),
      ...common,
    }
  }

  const save = useMutation(() => ({
    mutationFn: async () => {
      const name = form.name.trim()
      const config = buildConfig()
      const renamed = isEdit && props.name && props.name !== name
      const result = await globalSync.editMcp({
        set: { [name]: config },
        ...(renamed ? { remove: [props.name!] } : {}),
      })
      return { name, result }
    },
    onSuccess: () => dialog.close(),
    onError: (error) => {
      showToast({
        variant: "error",
        title: language.t("settings.mcp.toast.saveFailed.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  const remove = useMutation(() => ({
    mutationFn: async () => globalSync.editMcp({ remove: [props.name!] }),
    onSuccess: (result) => {
      if (result?.missing?.length) {
        showToast({
          variant: "error",
          title: language.t("settings.mcp.toast.missing.title"),
          description: language.t("settings.mcp.toast.missing.description", { name: props.name ?? "" }),
        })
      }
      dialog.close()
    },
    onError: (error) => {
      showToast({
        variant: "error",
        title: language.t("settings.mcp.toast.deleteFailed.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  const busy = () => save.isPending || remove.isPending

  const submit = (e: SubmitEvent) => {
    e.preventDefault()
    if (busy()) return
    if (!validate()) return
    save.mutate()
  }

  const setType = (type: "local" | "remote") => batch(() => setForm({ type, err: {} }))

  return (
    <Dialog title={language.t(isEdit ? "settings.mcp.edit" : "settings.mcp.add")}>
      <form onSubmit={submit} class="flex flex-col gap-5 px-5 pb-5 overflow-y-auto max-h-[60vh]">
        <div class="flex flex-col gap-1.5">
          <label class="text-small text-fg-weak">{language.t("settings.mcp.field.type")}</label>
          <div class="inline-flex w-max rounded-md border border-border-weak overflow-hidden">
            <For each={["local", "remote"] as const}>
              {(type) => (
                <button
                  type="button"
                  class="h-7 px-3.5 text-body"
                  classList={{
                    "bg-surface-interactive-base text-fg-strong": form.type === type,
                    "bg-bg-base text-fg-weak": form.type !== type,
                  }}
                  onClick={() => setType(type)}
                >
                  {language.t(`settings.mcp.field.type.${type}`)}
                </button>
              )}
            </For>
          </div>
        </div>

        <TextField
          autofocus
          label={language.t("settings.mcp.field.name")}
          placeholder={language.t("settings.mcp.field.name.placeholder")}
          value={form.name}
          onChange={(v) => batch(() => setForm({ name: v, err: { ...form.err, name: undefined } }))}
          validationState={form.err.name ? "invalid" : undefined}
          error={form.err.name}
        />

        <Show when={form.type === "local"}>
          <TextField
            label={language.t("settings.mcp.field.command")}
            placeholder={language.t("settings.mcp.field.command.placeholder")}
            description={language.t("settings.mcp.field.command.description")}
            value={form.command}
            onChange={(v) => batch(() => setForm({ command: v, err: { ...form.err, command: undefined } }))}
            validationState={form.err.command ? "invalid" : undefined}
            error={form.err.command}
          />
          <KvRows
            label={language.t("settings.mcp.field.env")}
            addLabel={language.t("settings.mcp.field.env.add")}
            removeLabel={language.t("settings.mcp.field.env.remove")}
            keyPlaceholder={language.t("settings.mcp.field.key.placeholder")}
            valuePlaceholder={language.t("settings.mcp.field.value.placeholder")}
            rows={form.env}
            onAdd={() => addRow("env")}
            onRemove={(i) => removeRow("env", i)}
            onChange={(i, k, v) => setRow("env", i, k, v)}
          />
        </Show>

        <Show when={form.type === "remote"}>
          <TextField
            label={language.t("settings.mcp.field.url")}
            placeholder={language.t("settings.mcp.field.url.placeholder")}
            value={form.url}
            onChange={(v) => batch(() => setForm({ url: v, err: { ...form.err, url: undefined } }))}
            validationState={form.err.url ? "invalid" : undefined}
            error={form.err.url}
          />
          <KvRows
            label={language.t("settings.mcp.field.headers")}
            addLabel={language.t("settings.mcp.field.headers.add")}
            removeLabel={language.t("settings.mcp.field.headers.remove")}
            keyPlaceholder={language.t("settings.mcp.field.header.key.placeholder")}
            valuePlaceholder={language.t("settings.mcp.field.header.value.placeholder")}
            rows={form.headers}
            onAdd={() => addRow("headers")}
            onRemove={(i) => removeRow("headers", i)}
            onChange={(i, k, v) => setRow("headers", i, k, v)}
          />
        </Show>

        <div class="flex items-center gap-2 pt-1">
          <Button type="submit" variant="primary" disabled={busy()}>
            {save.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => dialog.close()} disabled={busy()}>
            {language.t("common.cancel")}
          </Button>
          <div class="flex-1" />
          <Show when={isEdit}>
            <Show
              when={form.confirmingDelete}
              fallback={
                <Button
                  type="button"
                  variant="ghost"
                  icon="trash"
                  class="text-error"
                  disabled={busy()}
                  onClick={() => setForm("confirmingDelete", true)}
                >
                  {language.t("common.delete")}
                </Button>
              }
            >
              <span class="text-small text-fg-weak">{language.t("settings.mcp.delete.confirm")}</span>
              <Button
                type="button"
                variant="ghost"
                class="text-error"
                disabled={busy()}
                onClick={() => remove.mutate()}
              >
                {language.t("common.delete")}
              </Button>
              <Button type="button" variant="ghost" disabled={busy()} onClick={() => setForm("confirmingDelete", false)}>
                {language.t("common.cancel")}
              </Button>
            </Show>
          </Show>
        </div>
      </form>
    </Dialog>
  )
}

function KvRows(props: {
  label: string
  addLabel: string
  removeLabel: string
  keyPlaceholder: string
  valuePlaceholder: string
  rows: KvRow[]
  onAdd: () => void
  onRemove: (index: number) => void
  onChange: (index: number, key: "key" | "value", value: string) => void
}) {
  return (
    <div class="flex flex-col gap-2">
      <label class="text-small text-fg-weak">{props.label}</label>
      <For each={props.rows}>
        {(row, i) => (
          <div class="flex gap-2 items-start">
            <div class="flex-1">
              <TextField
                label={props.keyPlaceholder}
                hideLabel
                placeholder={props.keyPlaceholder}
                value={row.key}
                onChange={(v) => props.onChange(i(), "key", v)}
              />
            </div>
            <div class="flex-1">
              <TextField
                label={props.valuePlaceholder}
                hideLabel
                placeholder={props.valuePlaceholder}
                value={row.value}
                onChange={(v) => props.onChange(i(), "value", v)}
              />
            </div>
            <IconButton
              type="button"
              icon="trash"
              variant="ghost"
              class="mt-1"
              onClick={() => props.onRemove(i())}
              disabled={props.rows.length <= 1}
              aria-label={props.removeLabel}
            />
          </div>
        )}
      </For>
      <Button type="button" variant="ghost" icon="plus-small" onClick={props.onAdd} class="self-start">
        {props.addLabel}
      </Button>
    </div>
  )
}
