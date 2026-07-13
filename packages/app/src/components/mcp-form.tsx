import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Sheet } from "@opencode-ai/ui/sheet"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { batch, createSignal, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@opencode-ai/sdk/v2/client"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { joinCommand, splitCommand } from "@/components/mcp-command"
import { readMcpAuth, writeMcpAuth } from "@/components/mcp-auth-form"
import { McpAuthFields } from "@/components/mcp-auth-fields"
import { McpDeleteDialog } from "@/components/mcp-delete-dialog"
import { McpKvRows, type McpKvRow } from "@/components/mcp-kv-rows"
import { McpProbeSection } from "@/components/mcp-probe-section"

type McpConfig = McpLocalConfig | McpRemoteConfig
type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "add" | "edit"
  name?: string
  config?: McpConfig
  existingNames: string[]
  directory?: string
}

function recordToRows(record: Record<string, string> | undefined): McpKvRow[] {
  const rows = Object.entries(record ?? {}).map(([key, value]) => ({ key, value }))
  return rows.length ? rows : [{ key: "", value: "" }]
}

function rowsToRecord(rows: McpKvRow[]): Record<string, string> | undefined {
  const output: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    output[key] = row.value
  }
  return Object.keys(output).length ? output : undefined
}

export function McpForm(props: Props) {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const dialog = useDialog()
  const initial = props.config
  const initialType = initial?.type === "remote" ? "remote" : "local"
  const initialAuth = readMcpAuth(initial?.type === "remote" ? initial.headers : undefined)
  const isEdit = props.mode === "edit"
  const [probeResult, setProbeResult] = createSignal<McpStatus>()

  const [form, setForm] = createStore({
    type: initialType as "local" | "remote",
    name: props.name ?? "",
    command: initial?.type === "local" ? joinCommand(initial.command) : "",
    url: initial?.type === "remote" ? initial.url : "",
    authMode: initialAuth.mode,
    token: initialAuth.token,
    env: recordToRows(initial?.type === "local" ? initial.environment : undefined),
    headers: recordToRows(initial?.type === "remote" ? initial.headers : undefined),
    err: {} as { name?: string; command?: string; url?: string },
  })

  const clearProbe = () => setProbeResult(undefined)
  const addRow = (field: "env" | "headers") => {
    clearProbe()
    setForm(field, produce((rows) => rows.push({ key: "", value: "" })))
  }
  const removeRow = (field: "env" | "headers", index: number) => {
    clearProbe()
    setForm(field, produce((rows) => rows.length > 1 && rows.splice(index, 1)))
  }
  const setRow = (field: "env" | "headers", index: number, key: "key" | "value", value: string) => {
    clearProbe()
    setForm(field, index, key, value)
  }

  const validate = (includeName = true) => {
    const err: { name?: string; command?: string; url?: string } = {}
    const name = form.name.trim()
    if (includeName && !name) err.name = language.t("settings.mcp.error.name.required")
    else if (includeName && name !== props.name && props.existingNames.includes(name))
      err.name = language.t("settings.mcp.error.name.duplicate", { name })
    if (form.type === "local" && splitCommand(form.command).length === 0)
      err.command = language.t("settings.mcp.error.command.required")
    if (form.type === "remote" && !form.url.trim()) err.url = language.t("settings.mcp.error.url.required")
    setForm("err", err)
    return Object.keys(err).length === 0
  }

  const buildConfig = (): McpConfig => {
    const enabled = initial?.enabled
    const timeout = initial?.timeout
    const common = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    }
    if (form.type === "local") {
      const environment = rowsToRecord(form.env)
      return {
        type: "local",
        command: splitCommand(form.command),
        ...(environment ? { environment } : {}),
        ...common,
      }
    }
    const headers = writeMcpAuth(form.authMode, form.token, rowsToRecord(form.headers))
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
      const renamed = isEdit && props.name && props.name !== name
      return globalSync.editMcp({
        set: { [name]: buildConfig() },
        ...(renamed ? { remove: [props.name!] } : {}),
      })
    },
    onSuccess: () => props.onOpenChange(false),
    onError: (error) => {
      showToast({
        variant: "error",
        title: language.t("settings.mcp.toast.saveFailed.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  const probe = useMutation(() => ({
    mutationFn: () => globalSync.probeMcp({ config: buildConfig(), directory: props.directory }),
    onSuccess: setProbeResult,
    onError: (error) =>
      setProbeResult({ status: "failed", error: error instanceof Error ? error.message : String(error) }),
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
      props.onOpenChange(false)
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
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (busy() || !validate()) return
    save.mutate()
  }
  const testConnection = () => {
    if (probe.isPending || !validate(false)) return
    probe.mutate()
  }
  const setType = (type: "local" | "remote") => {
    clearProbe()
    batch(() => setForm({ type, err: {} }))
  }
  const confirmDelete = () =>
    dialog.show(() => (
      <McpDeleteDialog
        name={props.name ?? ""}
        onDelete={() => remove.mutateAsync()}
      />
    ))

  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => !busy() && props.onOpenChange(open)}
      title={language.t(isEdit ? "settings.mcp.edit" : "settings.mcp.add")}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={busy()} onClick={() => props.onOpenChange(false)}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" form="mcp-server-form" variant="primary" disabled={busy()}>
            {save.isPending ? language.t("common.saving") : language.t("settings.mcp.save")}
          </Button>
        </>
      }
    >
      <form id="mcp-server-form" onSubmit={submit} class="flex flex-col gap-5">
        <div class="flex flex-col gap-1.5">
          <span class="text-small text-fg-weak">{language.t("settings.mcp.field.type")}</span>
          <div class="flex w-max gap-1" role="group" aria-label={language.t("settings.mcp.field.type")}>
            <For each={["local", "remote"] as const}>
              {(type) => (
                <Button
                  type="button"
                  variant={form.type === type ? "secondary" : "ghost"}
                  aria-pressed={form.type === type}
                  onClick={() => setType(type)}
                >
                  {language.t(`settings.mcp.field.type.${type}`)}
                </Button>
              )}
            </For>
          </div>
        </div>

        <TextField
          autofocus
          label={language.t("settings.mcp.field.name")}
          placeholder={language.t("settings.mcp.field.name.placeholder")}
          value={form.name}
          onChange={(value) => batch(() => setForm({ name: value, err: { ...form.err, name: undefined } }))}
          validationState={form.err.name ? "invalid" : undefined}
          error={form.err.name}
        />

        <Show when={form.type === "local"}>
          <TextField
            label={language.t("settings.mcp.field.command")}
            placeholder={language.t("settings.mcp.field.command.placeholder")}
            description={language.t("settings.mcp.field.command.description")}
          value={form.command}
            onChange={(value) => {
              clearProbe()
              batch(() => setForm({ command: value, err: { ...form.err, command: undefined } }))
            }}
            validationState={form.err.command ? "invalid" : undefined}
            error={form.err.command}
          />
          <McpKvRows
            label={language.t("settings.mcp.field.env")}
            description={language.t("settings.mcp.field.env.description")}
            addLabel={language.t("settings.mcp.field.env.add")}
            removeLabel={language.t("settings.mcp.field.env.remove")}
            keyPlaceholder={language.t("settings.mcp.field.key.placeholder")}
            valuePlaceholder={language.t("settings.mcp.field.value.placeholder")}
            rows={form.env}
            maskValue
            onAdd={() => addRow("env")}
            onRemove={(index) => removeRow("env", index)}
            onChange={(index, key, value) => setRow("env", index, key, value)}
          />
        </Show>

        <Show when={form.type === "remote"}>
          <TextField
            label={language.t("settings.mcp.field.url")}
            placeholder={language.t("settings.mcp.field.url.placeholder")}
            value={form.url}
            onChange={(value) => {
              clearProbe()
              batch(() => setForm({ url: value, err: { ...form.err, url: undefined } }))
            }}
            validationState={form.err.url ? "invalid" : undefined}
            error={form.err.url}
          />
          <McpAuthFields
            mode={form.authMode}
            token={form.token}
            headers={form.headers}
            onModeChange={(mode) => {
              clearProbe()
              setForm("authMode", mode)
            }}
            onTokenChange={(value) => {
              clearProbe()
              setForm("token", value)
            }}
            onAddHeader={() => addRow("headers")}
            onRemoveHeader={(index) => removeRow("headers", index)}
            onHeaderChange={(index, key, value) => setRow("headers", index, key, value)}
          />
        </Show>

        <McpProbeSection result={probeResult()} pending={probe.isPending} onTest={testConnection} />

        <Show when={isEdit}>
          <div class="flex items-center justify-between gap-4 border-t border-border-weak pt-4">
            <div class="min-w-0">
              <div class="text-body text-fg-strong">{language.t("settings.mcp.delete.section")}</div>
              <div class="text-small text-fg-weak">{language.t("settings.mcp.delete.description")}</div>
            </div>
            <Button type="button" variant="danger" disabled={busy()} onClick={confirmDelete}>
              {language.t("settings.mcp.delete.action")}
            </Button>
          </div>
        </Show>
      </form>
    </Sheet>
  )
}
