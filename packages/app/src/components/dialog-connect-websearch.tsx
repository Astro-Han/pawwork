import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createResource, createSignal, Match, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { Link } from "./link"

export function DialogConnectWebSearch(props: { onStatusChanged?: () => void } = {}) {
  const dialog = useDialog()
  const language = useLanguage()

  const [webSearchStatusResource, webSearchStatusActions] = createResource(() => {
    const load = window.api?.webSearchStatus
    if (!load) throw new Error("Web Search settings are unavailable.")
    return load()
  })
  const status = createMemo(() => webSearchStatusResource.latest)
  const statusError = createMemo(() => webSearchStatusResource.error)

  const [apiKeyInput, setApiKeyInput] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)
  // Validation error clears on input change (addresses PR #271 review P3).
  const [validationError, setValidationError] = createSignal("")

  const title = createMemo(() => {
    const s = status()
    if (statusError()) return language.t("common.requestFailed")
    if (!s) return language.t("common.loading")
    if (s.source === "saved" && s.quotaExceeded) return language.t("dialog.websearch.title.savedQuota")
    if (s.source === "saved" && s.needsAttention) return language.t("dialog.websearch.title.failed")
    if (s.source === "saved") return language.t("dialog.websearch.title.saved")
    if (s.source === "anonymous" && s.quotaExceeded) return language.t("dialog.websearch.title.exhausted")
    return language.t("dialog.websearch.title.default")
  })

  const handleSave = () => {
    if (saving() || removing()) return
    const key = apiKeyInput().trim()
    if (!key) {
      setValidationError(language.t("provider.connect.apiKey.required"))
      return
    }
    if (!window.api?.saveExaApiKey) return
    setSaving(true)
    setValidationError("")
    void window.api
      .saveExaApiKey(key)
      .then(() => {
        setApiKeyInput("")
        void webSearchStatusActions.refetch()
        props.onStatusChanged?.()
        dialog.close()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("toast.websearch.saved.title"),
        })
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err || language.t("common.requestFailed"))
        // Surface inline for key-shaped errors; toast for other errors.
        setValidationError(msg)
      })
      .finally(() => setSaving(false))
  }

  const handleRemove = () => {
    if (saving() || removing()) return
    if (!window.api?.removeExaApiKey) return
    setRemoving(true)
    setValidationError("")
    void window.api
      .removeExaApiKey()
      .then(() => {
        setApiKeyInput("")
        void webSearchStatusActions.refetch()
        props.onStatusChanged?.()
        dialog.close()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("toast.websearch.removed.title"),
        })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
          variant: "error",
        })
      })
      .finally(() => setRemoving(false))
  }

  const renderSavedKeyForm = (statusKey: "dialog.websearch.status.savedQuota" | "dialog.websearch.status.failed") => (
    <div class="flex flex-col gap-4">
      <div class="text-14-regular text-text-base">{language.t(statusKey)}</div>
      <TextField
        autofocus
        type="password"
        label={language.t("dialog.websearch.placeholder")}
        hideLabel
        placeholder={language.t("dialog.websearch.placeholder")}
        value={apiKeyInput()}
        onChange={(v) => {
          setApiKeyInput(v)
          if (validationError()) setValidationError("")
        }}
        validationState={validationError() ? "invalid" : undefined}
        error={validationError()}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck={false}
      />
      <div class="flex gap-2">
        <Button size="large" variant="ghost" disabled={removing() || saving()} onClick={handleRemove}>
          {language.t("dialog.websearch.action.removeShort")}
        </Button>
        <Button
          size="large"
          variant="primary"
          disabled={saving() || removing() || apiKeyInput().trim() === ""}
          onClick={handleSave}
        >
          {language.t("dialog.websearch.action.saveShort")}
        </Button>
      </div>
    </div>
  )

  return (
    <Dialog
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={() => dialog.close()}
          aria-label={language.t("common.goBack")}
        />
      }
    >
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        {/* Header: service icon + title */}
        <div class="px-2.5 flex gap-4 items-center">
          <Icon name="link" class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">{title()}</div>
        </div>

        <div class="px-2.5 pb-10 flex flex-col gap-6">
          <Switch>
            {/* loading/error state: avoid showing anonymous setup before status is known */}
            <Match when={statusError()}>
              <div class="flex flex-col gap-4">
                <div class="text-14-regular text-text-base">{language.t("dialog.websearch.status.error")}</div>
                <Button size="large" variant="primary" onClick={() => void webSearchStatusActions.refetch()}>
                  {language.t("dialog.websearch.action.retry")}
                </Button>
              </div>
            </Match>

            <Match when={!status()}>
              <div class="text-14-regular text-text-base">{language.t("dialog.websearch.status.loading")}</div>
            </Match>

            {/* env state: read-only, no input, no save/remove */}
            <Match when={status()?.source === "env"}>
              <div class="text-14-regular text-text-base">{language.t("dialog.websearch.body.env")}</div>
            </Match>

            {/* saved + healthy state */}
            <Match when={status()?.source === "saved" && !status()?.needsAttention && !status()?.quotaExceeded}>
              <div class="flex flex-col gap-4">
                <div class="text-14-regular text-text-base">{language.t("dialog.websearch.status.active")}</div>
                <div class="flex gap-2">
                  <Button size="large" variant="ghost" disabled={removing() || saving()} onClick={handleRemove}>
                    {language.t("dialog.websearch.action.remove")}
                  </Button>
                  <Button
                    size="large"
                    variant="primary"
                    disabled={saving() || removing() || apiKeyInput().trim() === ""}
                    onClick={handleSave}
                  >
                    {language.t("dialog.websearch.action.update")}
                  </Button>
                </div>
                <TextField
                  autofocus
                  type="password"
                  label={language.t("dialog.websearch.placeholder")}
                  hideLabel
                  placeholder={language.t("dialog.websearch.placeholder")}
                  value={apiKeyInput()}
                  onChange={(v) => {
                    setApiKeyInput(v)
                    // Clear validation error on input change (PR #271 review P3).
                    if (validationError()) setValidationError("")
                  }}
                  validationState={validationError() ? "invalid" : undefined}
                  error={validationError()}
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="off"
                  spellcheck={false}
                />
              </div>
            </Match>

            {/* saved + quota exceeded state */}
            <Match when={status()?.source === "saved" && status()?.quotaExceeded}>
              {renderSavedKeyForm("dialog.websearch.status.savedQuota")}
            </Match>

            {/* saved + needsAttention state */}
            <Match when={status()?.source === "saved" && status()?.needsAttention}>
              {renderSavedKeyForm("dialog.websearch.status.failed")}
            </Match>

            {/* anonymous (default) state */}
            <Match when={status()?.source === "anonymous"}>
              <div class="flex flex-col gap-4">
                <div class="text-14-regular text-text-base">
                  {language.t(
                    status()?.quotaExceeded
                      ? "dialog.websearch.body.exhausted.line1"
                      : "dialog.websearch.body.default.line1",
                  )}
                </div>
                <div class="text-14-regular text-text-base">
                  {language.t(
                    status()?.quotaExceeded
                      ? "dialog.websearch.body.exhausted.line2"
                      : "dialog.websearch.body.default.line2",
                  )}
                </div>
                <TextField
                  autofocus
                  type="password"
                  label={language.t("dialog.websearch.placeholder")}
                  hideLabel
                  placeholder={language.t("dialog.websearch.placeholder")}
                  value={apiKeyInput()}
                  onChange={(v) => {
                    setApiKeyInput(v)
                    if (validationError()) setValidationError("")
                  }}
                  validationState={validationError() ? "invalid" : undefined}
                  error={validationError()}
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="off"
                  spellcheck={false}
                />
                <div class="text-13-regular text-text-weak">
                  {language.t(
                    status()?.quotaExceeded ? "dialog.websearch.status.exhausted" : "dialog.websearch.status.bundled",
                  )}
                </div>
                <div class="flex flex-col gap-2">
                  <Button
                    size="large"
                    variant="primary"
                    disabled={saving() || removing() || apiKeyInput().trim() === ""}
                    onClick={handleSave}
                  >
                    {language.t("dialog.websearch.action.save")}
                  </Button>
                  <Show when={!saving()}>
                    <div class="text-13-regular text-text-weak">
                      <Link href="https://exa.ai">{language.t("dialog.websearch.help.getKey")}</Link>
                    </div>
                  </Show>
                </div>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Dialog>
  )
}
