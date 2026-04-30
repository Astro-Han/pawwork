import { TextField } from "@opencode-ai/ui/text-field"
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
        reportConfirmOpen: false,
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
        setStore({ reporting: false, reportConfirmOpen: false })
      })
  }

  return (
    <div class="relative flex-1 h-screen w-screen min-h-0 overflow-y-auto bg-background-base font-sans">
      <div class="w-full max-w-[32rem] flex flex-col pt-[28vh] pb-16 pl-[clamp(1.5rem,10vw,6rem)] pr-6">
        <div class="flex flex-col gap-3">
          <h1 class="text-28-regular text-text-strong text-balance">{language.t("error.page.title")}</h1>
          <p class="text-16-regular text-text-base text-balance">{language.t("error.page.description")}</p>
        </div>

        <Show when={knownError()}>
          {(known) => (
            <div class="mt-8 flex flex-col gap-2">
              <div class="text-13-medium text-text-strong">{known().title}</div>
              <p class="text-13-regular text-text-weak leading-relaxed">{known().description}</p>
            </div>
          )}
        </Show>

        <div class="mt-10 flex flex-col items-start gap-5">
          <Show
            when={platform.checkUpdate && store.version}
            fallback={
              <Button size="large" onClick={platform.restart}>
                {language.t("error.page.action.restart")}
              </Button>
            }
          >
            <Button size="large" onClick={installUpdate}>
              {language.t("error.page.action.updateTo", { version: store.version ?? "" })}
            </Button>
          </Show>
          <div class="flex items-center gap-2 text-13-regular text-text-base">
            <Show
              when={platform.checkUpdate && store.version}
              fallback={
                <Show when={platform.checkUpdate}>
                  <button
                    type="button"
                    class="hover:text-text-strong transition-colors disabled:opacity-50"
                    onClick={checkForUpdates}
                    disabled={store.checking}
                  >
                    {store.checking
                      ? language.t("error.page.action.checking")
                      : language.t("error.page.action.checkUpdates")}
                  </button>
                </Show>
              }
            >
              <button type="button" class="hover:text-text-strong transition-colors" onClick={platform.restart}>
                {language.t("error.page.action.restart")}
              </button>
            </Show>
            <Show when={platform.checkUpdate}>
              <span class="text-text-weaker" aria-hidden="true">
                ·
              </span>
            </Show>
            <button
              type="button"
              class="hover:text-text-strong transition-colors disabled:opacity-50"
              onClick={() => setStore("reportConfirmOpen", true)}
              disabled={store.reporting}
            >
              {store.reporting ? language.t("error.page.report.preparing") : language.t("error.page.report.action")}
            </button>
          </div>
        </div>

        <Show when={store.reportConfirmOpen}>
          <div class="mt-8 flex flex-col gap-3 text-13-regular">
            <p class="text-text-base leading-relaxed">{language.t("error.page.report.confirm.description")}</p>
            <p class="text-text-weak leading-relaxed">{language.t("error.page.report.confirm.privacy")}</p>
            <details class="text-text-weak">
              <summary class="cursor-pointer text-text-interactive-base select-none">
                {language.t("error.page.report.confirm.details")}
              </summary>
              <ul class="mt-2 list-disc pl-5">
                <li>{language.t("error.page.report.confirm.item.error")}</li>
                <li>{language.t("error.page.report.confirm.item.app")}</li>
                <li>{language.t("error.page.report.confirm.item.logs")}</li>
                <li>{language.t("error.page.report.confirm.item.context")}</li>
              </ul>
            </details>
            <div class="mt-1 flex items-center gap-2">
              <Button
                variant="ghost"
                size="large"
                onClick={() => setStore("reportConfirmOpen", false)}
                disabled={store.reporting}
              >
                {language.t("common.cancel")}
              </Button>
              <Button size="large" onClick={reportProblem} disabled={store.reporting}>
                {language.t("error.page.report.confirm.continue")}
              </Button>
            </div>
          </div>
        </Show>

        <Show when={store.actionError}>
          {(message) => <p class="mt-6 text-12-regular text-text-danger-base">{message()}</p>}
        </Show>
        <Show when={store.actionMessage}>
          {(message) => <p class="mt-6 text-12-regular text-text-weak">{message()}</p>}
        </Show>

        <details class="group mt-16">
          <summary class="cursor-pointer select-none text-13-regular text-text-weak hover:text-text-base transition-colors list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden">
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              class="transition-transform group-open:rotate-90"
              fill="none"
              aria-hidden="true"
            >
              <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {language.t("error.page.details.label")}
          </summary>
          <div class="mt-4 flex flex-col gap-3">
            <TextField
              value={errorDetails()}
              readOnly
              copyable
              multiline
              class="max-h-72 w-full font-mono text-xs no-scrollbar"
              label={language.t("error.page.details.label")}
              hideLabel
            />
            <div class="flex items-center gap-2 text-12-regular text-text-weaker">
              <Show when={platform.version}>
                {(version) => (
                  <>
                    <span>{language.t("error.page.version", { version: version() })}</span>
                    <span class="text-text-weaker" aria-hidden="true">
                      ·
                    </span>
                  </>
                )}
              </Show>
              <button
                type="button"
                class="hover:text-text-weak transition-colors"
                onClick={() => platform.openLink(store.feedbackUrl ?? PAWWORK_GITHUB_ISSUE_URL)}
              >
                {store.feedbackUrl
                  ? language.t("error.page.report.formFallbackAction")
                  : language.t("error.page.report.githubFallback")}
              </button>
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}
