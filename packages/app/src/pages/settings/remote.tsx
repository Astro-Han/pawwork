import { Button } from "@opencode-ai/ui/button"
import { Icon, type IconName } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type Component,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { RemoteAccessConfig } from "@/desktop-api-contract"
import {
  FIELD_HINT,
  FIELD_LABEL,
  PLATFORM_FIELDS,
  PLATFORM_NAME,
  PLATFORM_ORDER,
  PlatformLogo,
} from "./remote-platforms"

const REMOTE_ACCESS_STATUS_POLL_MS = 3_000

const STATUS_VISUAL: Record<string, { icon: IconName; class: string; spin?: boolean }> = {
  running: { icon: "circle-check", class: "bg-success-bg text-success-text" },
  starting: { icon: "refresh", class: "bg-warning-bg text-warning-text", spin: true },
  error: { icon: "circle-x", class: "bg-error-bg text-error-text" },
  idle: { icon: "circle", class: "bg-bg-cream text-fg-weaker" },
}

const STATUS_LABELS = {
  running: "settings.remote.status.running",
  starting: "settings.remote.status.starting",
  error: "settings.remote.status.error",
  idle: "settings.remote.status.idle",
} as const

const StatusBadge: Component<{ state: string; label: string }> = (props) => {
  const visual = () => STATUS_VISUAL[props.state] ?? STATUS_VISUAL.idle
  return (
    <span
      data-action="settings-remote-status"
      class={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-body font-medium ${visual().class}`}
    >
      <Icon name={visual().icon} classList={{ "animate-spin": !!visual().spin }} />
      {props.label}
    </span>
  )
}

const ConfigField: Component<{
  fieldKey: string
  label: string
  hint?: string
  secret?: boolean
  required?: boolean
  value: string
  onInput: (value: string) => void
}> = (props) => {
  return (
    <div class="flex flex-col gap-1.5">
      <label
        class="flex items-center gap-1 text-body font-medium text-fg-strong"
        for={`remote-field-${props.fieldKey}`}
      >
        {props.label}
        <Show when={props.required}>
          <span class="text-error">*</span>
        </Show>
      </label>
      <input
        id={`remote-field-${props.fieldKey}`}
        data-field={props.fieldKey}
        type={props.secret ? "password" : "text"}
        class="h-9 w-full rounded-md border border-border-weak bg-surface-base px-2.5 text-body text-fg-base outline-none focus:border-transparent focus:shadow-[var(--shadow-xs-border-focus)]"
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <Show when={props.hint}>{(hint) => <span class="text-caption text-fg-weak">{hint()}</span>}</Show>
    </div>
  )
}

export const RemotePage: Component = () => {
  const language = useLanguage()
  const [enabled, setEnabled] = createSignal(false)
  const [platform, setPlatform] = createSignal("feishu")
  const [optionsByPlatform, setOptionsByPlatform] = createStore<Record<string, Record<string, unknown>>>({})
  const [rawDraft, setRawDraft] = createSignal("{}")
  const [rawError, setRawError] = createSignal<string>()
  const [formError, setFormError] = createSignal<string>()
  const [working, setWorking] = createSignal(false)

  const [configResource] = createResource(() => window.api?.remoteAccessConfig?.())
  const [status, { mutate, refetch }] = createResource(() => window.api?.remoteAccessStatus?.())

  createEffect(() => {
    const config = configResource.latest
    if (!config) return
    setEnabled(config.enabled)
    setOptionsByPlatform(config.platform, { ...(config.options ?? {}) })
    setPlatform(config.platform)
  })

  const fields = createMemo(() => PLATFORM_FIELDS[platform()])
  const options = createMemo(() => optionsByPlatform[platform()] ?? {})

  const setOption = (key: string, value: unknown) =>
    setOptionsByPlatform(platform(), (prev) => ({ ...(prev ?? {}), [key]: value }))

  const stringOption = (key: string) => {
    const value = options()[key]
    return value === undefined || value === null ? "" : String(value)
  }

  const platformName = (id: string) => {
    const key = PLATFORM_NAME[id]
    return key ? language.t(key) : id
  }
  const fieldLabel = (key: string) => {
    const labelKey = FIELD_LABEL[key]
    return labelKey ? language.t(labelKey) : key
  }
  const fieldHint = (key: string) => {
    const hintKey = FIELD_HINT[key]
    return hintKey ? language.t(hintKey) : undefined
  }

  // On platform switch: seed the raw editor (no schema) or pre-fill structured defaults.
  createEffect(
    on(platform, (id) => {
      const list = PLATFORM_FIELDS[id]
      if (!list) {
        setRawError(undefined)
        setRawDraft(JSON.stringify(optionsByPlatform[id] ?? {}, null, 2))
        return
      }
      for (const item of list) {
        if (item.defaultValue === undefined) continue
        const current = optionsByPlatform[id]?.[item.key]
        if (current === undefined || current === "") {
          setOptionsByPlatform(id, (prev) => ({ ...(prev ?? {}), [item.key]: item.defaultValue }))
        }
      }
    }),
  )

  const onRawInput = (text: string) => {
    setRawDraft(text)
    try {
      const parsed = JSON.parse(text.trim() || "{}")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
      setRawError(undefined)
      setOptionsByPlatform(platform(), parsed as Record<string, unknown>)
    } catch {
      setRawError(language.t("settings.remote.options.invalid"))
    }
  }

  const available = createMemo(() => {
    const reported = status()?.platforms
    if (!reported?.length) return PLATFORM_ORDER
    const known = PLATFORM_ORDER.filter((id) => reported.includes(id))
    const extra = reported.filter((id) => !PLATFORM_ORDER.includes(id))
    return [...known, ...extra]
  })

  const missingRequired = createMemo(() => {
    const list = fields()
    if (!list) return [] as string[]
    return list.filter((item) => item.required && !stringOption(item.key).trim()).map((item) => item.key)
  })

  const state = createMemo(() => status()?.state ?? "idle")
  const isRunning = createMemo(() => state() === "running" || state() === "starting")

  const statusLabel = createMemo(() => language.t(STATUS_LABELS[state()]))

  const statusDetail = createMemo(() => {
    if (state() === "running") return language.t("settings.remote.status.ready")
    if (state() === "error") return status()?.lastError ?? language.t("settings.remote.status.error")
    return language.t("settings.remote.status.description")
  })

  createEffect(() => {
    if (!isRunning()) return
    const timer = setInterval(() => {
      void Promise.resolve(refetch()).then((next) => {
        if (next) mutate(next)
      })
    }, REMOTE_ACCESS_STATUS_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const buildConfig = (): RemoteAccessConfig | undefined => {
    if (!fields() && rawError()) {
      setFormError(language.t("settings.remote.options.invalid"))
      return
    }
    setFormError(undefined)
    return { enabled: enabled(), platform: platform(), options: { ...options() } }
  }

  const remoteActionError = (error: unknown) => {
    const detail = error instanceof Error ? error.message : typeof error === "string" ? error : ""
    setFormError(
      detail
        ? `${language.t("settings.remote.action.failed")}: ${detail}`
        : language.t("settings.remote.action.failed"),
    )
  }

  const save = async () => {
    const config = buildConfig()
    if (!config) return
    setWorking(true)
    try {
      await window.api?.remoteAccessSaveConfig?.(config)
      const next = await window.api?.remoteAccessStatus?.()
      if (next) mutate(next)
    } catch (error) {
      remoteActionError(error)
    } finally {
      setWorking(false)
    }
  }

  const start = async () => {
    const config = buildConfig()
    if (!config) return
    if (missingRequired().length) {
      setFormError(language.t("settings.remote.required"))
      return
    }
    setWorking(true)
    try {
      const next = await window.api?.remoteAccessStart?.({ ...config, enabled: true })
      setEnabled(true)
      if (next) mutate(next)
    } catch (error) {
      remoteActionError(error)
    } finally {
      setWorking(false)
    }
  }

  const stop = async () => {
    setWorking(true)
    try {
      const next = await window.api?.remoteAccessStop?.()
      setEnabled(false)
      if (next) mutate(next)
    } catch (error) {
      remoteActionError(error)
    } finally {
      setWorking(false)
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--bg-base)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-h2 text-fg-strong">{language.t("settings.tab.remoteAccess")}</h2>
          <p class="text-body text-fg-weak">{language.t("settings.remote.description")}</p>
        </div>
      </div>

      <div class="flex w-full flex-col gap-10 pb-4">
        <section class="flex flex-col gap-3">
          <div class="flex flex-col gap-0.5">
            <h3 class="text-h3 text-fg-strong">{language.t("settings.remote.platform.title")}</h3>
            <p class="text-body text-fg-weak">{language.t("settings.remote.platform.description")}</p>
          </div>
          <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            <For each={available()}>
              {(id) => (
                <button
                  type="button"
                  data-action="settings-remote-platform"
                  data-platform={id}
                  aria-pressed={platform() === id}
                  onClick={() => setPlatform(id)}
                  class="flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors"
                  classList={{
                    "border-brand-primary bg-surface-interactive-base ring-1 ring-brand-primary": platform() === id,
                    "border-border-weak bg-bg-base hover:bg-bg-cream": platform() !== id,
                  }}
                >
                  <PlatformLogo platform={id} size={28} />
                  <span class="min-w-0 truncate text-body font-medium text-fg-strong">{platformName(id)}</span>
                </button>
              )}
            </For>
          </div>
        </section>

        <section class="flex flex-col gap-3">
          <h3 class="text-h3 text-fg-strong">{language.t("settings.remote.section.config")}</h3>
          <Show
            when={fields()}
            fallback={
              <div class="flex w-full max-w-[520px] flex-col gap-1.5">
                <label class="text-body font-medium text-fg-strong">
                  {language.t("settings.remote.options.title")}
                </label>
                <textarea
                  data-action="settings-remote-options"
                  class="min-h-[160px] w-full resize-y rounded-md border border-border-weak bg-surface-base px-2.5 py-2 font-mono text-body text-fg-base outline-none focus:border-transparent focus:shadow-[var(--shadow-xs-border-focus)]"
                  spellcheck={false}
                  value={rawDraft()}
                  onInput={(event) => onRawInput(event.currentTarget.value)}
                />
                <Show when={rawError()}>{(message) => <span class="text-body text-error">{message()}</span>}</Show>
              </div>
            }
          >
            {(list) => (
              <div class="flex w-full max-w-[520px] flex-col gap-4">
                <For each={list()}>
                  {(item) => (
                    <Show
                      when={item.kind === "switch"}
                      fallback={
                        <ConfigField
                          fieldKey={item.key}
                          label={fieldLabel(item.key)}
                          hint={fieldHint(item.key)}
                          secret={item.kind === "secret"}
                          required={item.required}
                          value={stringOption(item.key)}
                          onInput={(value) => setOption(item.key, value)}
                        />
                      }
                    >
                      <div class="flex items-start justify-between gap-4">
                        <div class="flex flex-col gap-0.5">
                          <span class="text-body font-medium text-fg-strong">{fieldLabel(item.key)}</span>
                          <Show when={fieldHint(item.key)}>
                            {(hint) => <span class="text-caption text-fg-weak">{hint()}</span>}
                          </Show>
                        </div>
                        <div data-field={item.key} class="pt-0.5">
                          <Switch checked={!!options()[item.key]} onChange={(value) => setOption(item.key, value)} />
                        </div>
                      </div>
                    </Show>
                  )}
                </For>
              </div>
            )}
          </Show>
        </section>

        <section class="flex flex-col gap-3">
          <h3 class="text-h3 text-fg-strong">{language.t("settings.remote.section.status")}</h3>
          <div class="flex max-w-[520px] flex-col gap-3 rounded-md border border-border-weak bg-bg-base p-4">
            <div class="flex items-center justify-between gap-3">
              <span class="text-body font-medium text-fg-strong">{language.t("settings.remote.status.title")}</span>
              <StatusBadge state={state()} label={statusLabel()} />
            </div>
            <p class="text-body text-fg-weak">{statusDetail()}</p>
            <Show when={missingRequired().length > 0 && !isRunning()}>
              <p class="text-caption text-warning-text">{language.t("settings.remote.required")}</p>
            </Show>
            <Show when={formError()}>{(message) => <p class="text-body text-error">{message()}</p>}</Show>
            <div class="flex items-center gap-2 pt-1">
              <Button
                data-action="settings-remote-save"
                size="small"
                variant="ghost"
                disabled={working()}
                onClick={() => void save()}
              >
                {language.t("settings.remote.action.save")}
              </Button>
              <Button
                data-action="settings-remote-start"
                size="small"
                variant="primary"
                classList={{ hidden: isRunning() }}
                disabled={working() || missingRequired().length > 0}
                onClick={() => void start()}
              >
                {language.t("settings.remote.action.start")}
              </Button>
              <Button
                data-action="settings-remote-stop"
                size="small"
                variant="secondary"
                classList={{ hidden: !isRunning() }}
                disabled={working()}
                onClick={() => void stop()}
              >
                {language.t("settings.remote.action.stop")}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
