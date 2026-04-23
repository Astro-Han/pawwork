import { TextField } from "@opencode-ai/ui/text-field"
import { Logo } from "@opencode-ai/ui/logo"
import { Button } from "@opencode-ai/ui/button"
import { Component, Show, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import type { E2EWindow } from "@/testing/terminal"
import { updateErrorPageState } from "./error-update"
import { PAWWORK_GITHUB_ISSUE_URL } from "@/utils/support-links"
import { buildErrorReportDetails, errorReportStatusMessage, formatError, summarizeKnownError } from "./error-report"
export type { InitError } from "./error-report"

interface ErrorPageProps {
  error: unknown
}

type ErrorPageStore = {
  checking: boolean
  reporting: boolean
  reportConfirmOpen: boolean
  version: string | undefined
  actionError: string | undefined
  actionMessage: string | undefined
  feedbackUrl: string | undefined
}

export const ErrorPage: Component<ErrorPageProps> = (props) => {
  const platform = usePlatform()
  const language = useLanguage()
  const [store, setStore] = createStore<ErrorPageStore>({
    checking: false,
    reporting: false,
    reportConfirmOpen: false,
    version: undefined,
    actionError: undefined,
    actionMessage: undefined,
    feedbackUrl: undefined,
  })
  const knownError = createMemo(() => summarizeKnownError(props.error, language.t))
  const errorDetails = createMemo(() => formatError(props.error, language.t))
  const reportDetails = createMemo(() => buildErrorReportDetails(props.error, language.t))

  onMount(() => {
    const win = window as E2EWindow
    if (!win.__opencode_e2e) return
    const detail = errorDetails()
    console.error(`[e2e:error-boundary] ${window.location.pathname}\n${detail}`)
  })

  async function copyCurrentErrorDetails() {
    if (!navigator.clipboard?.writeText) return false
    try {
      await navigator.clipboard.writeText(errorDetails())
    } catch {
      return false
    }
    return true
  }

  async function checkForUpdates() {
    if (!platform.checkUpdate) return
    setStore("checking", true)
    await platform
      .checkUpdate()
      .then((result) => {
        setStore(updateErrorPageState(result, language.t))
      })
      .catch((err) => {
        setStore({
          version: undefined,
          actionError: formatError(err, language.t),
          actionMessage: undefined,
        })
      })
      .finally(() => {
        setStore("checking", false)
      })
  }

  async function installUpdate() {
    if (!platform.update) return
    await platform
      .update()
      .then(() => setStore({ actionError: undefined, actionMessage: undefined }))
      .catch((err) => {
        setStore({ actionError: formatError(err, language.t), actionMessage: undefined })
      })
  }

  async function reportProblem() {
    if (!platform.reportProblem) {
      setStore({
        actionError: undefined,
        actionMessage: language.t("error.page.report.unavailable"),
        feedbackUrl: undefined,
      })
      return
    }
    setStore({ reporting: true, actionError: undefined, actionMessage: undefined, feedbackUrl: undefined })
    await platform
      .reportProblem({ confirm: false, rendererError: reportDetails() })
      .then((result) => {
        setStore({
          feedbackUrl: result.status === "form-fallback" ? result.feedbackUrl : undefined,
          actionError: result.status === "failed" ? errorReportStatusMessage(result, language.t) : undefined,
          actionMessage: result.status === "failed" ? undefined : errorReportStatusMessage(result, language.t),
        })
      })
      .catch(async () => {
        const copied = await copyCurrentErrorDetails()
        setStore({
          actionError: copied ? undefined : language.t("error.page.report.failed"),
          actionMessage: copied ? language.t("error.page.report.copiedFallback") : undefined,
          feedbackUrl: undefined,
        })
      })
      .finally(() => {
        setStore("reporting", false)
      })
  }

  return (
    <div class="relative flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center bg-background-base font-sans">
      <div class="w-2/3 max-w-3xl flex flex-col items-center justify-center gap-8">
        <Logo class="w-58.5 opacity-12 shrink-0" />
        <div class="flex flex-col items-center gap-2 text-center">
          <h1 class="text-lg font-medium text-text-strong">{language.t("error.page.title")}</h1>
          <p class="text-sm text-text-weak">{language.t("error.page.description")}</p>
        </div>
        <Show when={knownError()}>
          {(known) => (
            <div class="w-full rounded-lg border border-border-subtle-base bg-background-muted p-4 text-left">
              <div class="text-sm font-medium text-text-strong">{known().title}</div>
              <p class="mt-1 text-sm text-text-weak">{known().description}</p>
            </div>
          )}
        </Show>
        <div class="flex items-center gap-3">
          <Button size="large" onClick={platform.restart}>
            {language.t("error.page.action.restart")}
          </Button>
          <Show when={platform.checkUpdate}>
            <Show
              when={store.version}
              fallback={
                <Button size="large" variant="ghost" onClick={checkForUpdates} disabled={store.checking}>
                  {store.checking
                    ? language.t("error.page.action.checking")
                    : language.t("error.page.action.checkUpdates")}
                </Button>
              }
            >
              <Button size="large" onClick={installUpdate}>
                {language.t("error.page.action.updateTo", { version: store.version ?? "" })}
              </Button>
            </Show>
          </Show>
        </div>
        <div class="flex flex-col items-center gap-3 text-center">
          <Button
            size="large"
            variant="secondary"
            onClick={() => setStore("reportConfirmOpen", true)}
            disabled={store.reporting}
          >
            {store.reporting ? language.t("error.page.report.preparing") : language.t("error.page.report.action")}
          </Button>
          <Show when={store.reportConfirmOpen}>
            <div class="w-full max-w-2xl rounded-lg border border-border-subtle-base bg-background-muted p-4 text-left">
              <p class="text-sm text-text-strong">{language.t("error.page.report.confirm.description")}</p>
              <p class="mt-1 text-sm text-text-weak">{language.t("error.page.report.confirm.privacy")}</p>
              <details class="mt-3 text-sm text-text-weak">
                <summary class="cursor-pointer text-text-interactive-base">
                  {language.t("error.page.report.confirm.details")}
                </summary>
                <ul class="mt-2 list-disc pl-5">
                  <li>{language.t("error.page.report.confirm.item.error")}</li>
                  <li>{language.t("error.page.report.confirm.item.app")}</li>
                  <li>{language.t("error.page.report.confirm.item.logs")}</li>
                  <li>{language.t("error.page.report.confirm.item.context")}</li>
                </ul>
              </details>
              <div class="mt-4">
                <Button size="large" onClick={reportProblem} disabled={store.reporting}>
                  {language.t("error.page.report.confirm.continue")}
                </Button>
              </div>
            </div>
          </Show>
          <button
            type="button"
            class="text-xs text-text-weak hover:text-text-interactive-base"
            onClick={() => platform.openLink(store.feedbackUrl ?? PAWWORK_GITHUB_ISSUE_URL)}
          >
            {store.feedbackUrl
              ? language.t("error.page.report.formFallbackAction")
              : language.t("error.page.report.githubFallback")}
          </button>
        </div>
        <Show when={store.actionError}>
          {(message) => <p class="text-xs text-text-danger-base text-center max-w-2xl">{message()}</p>}
        </Show>
        <Show when={store.actionMessage}>
          {(message) => <p class="text-xs text-text-weak text-center max-w-2xl">{message()}</p>}
        </Show>
        <TextField
          value={errorDetails()}
          readOnly
          copyable
          multiline
          class="max-h-96 w-full font-mono text-xs no-scrollbar"
          label={language.t("error.page.details.label")}
          hideLabel
        />
        <div class="flex flex-col items-center gap-2">
          <Show when={platform.version}>
            {(version) => (
              <p class="text-xs text-text-weak">{language.t("error.page.version", { version: version() })}</p>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
