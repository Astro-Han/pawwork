import { TextField } from "@opencode-ai/ui/text-field"
import { Button } from "@opencode-ai/ui/button"
import { Component, Show, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import type { E2EWindow } from "@/testing/terminal"
import { updateErrorPageState } from "./error-update"
import { PAWWORK_GITHUB_ISSUE_URL } from "@/utils/support-links"
import { buildErrorReportDetails, formatError, summarizeKnownError } from "./error-report"
import { DiagnosticsReviewBody } from "@/components/diagnostics-review"
import type { PrepareReportResult } from "@/desktop-api-contract"
export type { InitError } from "./error-report"

type ReadyReport = Extract<PrepareReportResult, { status: "ready" }>

interface ErrorPageProps {
  error: unknown
}

type ErrorPageStore = {
  checking: boolean
  reporting: boolean
  review: ReadyReport | undefined
  version: string | undefined
  actionError: string | undefined
  actionMessage: string | undefined
}

export const ErrorPage: Component<ErrorPageProps> = (props) => {
  const platform = usePlatform()
  const language = useLanguage()
  const [store, setStore] = createStore<ErrorPageStore>({
    checking: false,
    reporting: false,
    review: undefined,
    version: undefined,
    actionError: undefined,
    actionMessage: undefined,
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

  async function prepareDiagnostics() {
    if (!platform.prepareReport) {
      setStore({ review: undefined, actionError: undefined, actionMessage: language.t("error.page.report.unavailable") })
      return
    }
    setStore({ reporting: true, actionError: undefined, actionMessage: undefined })
    await platform
      .prepareReport({ rendererError: reportDetails() })
      .then((result) => {
        if (result.status === "ready") {
          setStore({ review: result, actionError: undefined, actionMessage: undefined })
          return
        }
        setStore({ review: undefined, actionError: language.t("diagnostics.review.prepareFailed"), actionMessage: undefined })
      })
      .catch(async () => {
        const copied = await copyCurrentErrorDetails()
        setStore({
          // Clear any prior successful review so a failed re-prepare can't leave stale content visible.
          review: undefined,
          actionError: copied ? undefined : language.t("error.page.report.failed"),
          actionMessage: copied ? language.t("error.page.report.copiedFallback") : undefined,
        })
      })
      .finally(() => {
        setStore("reporting", false)
      })
  }

  return (
    <div class="relative flex-1 h-screen w-screen min-h-0 overflow-y-auto bg-bg-base font-sans">
      <div class="w-full max-w-[32rem] flex flex-col pt-[28vh] pb-16 pl-[clamp(1.5rem,10vw,6rem)] pr-6">
        <div class="flex flex-col gap-3">
          <h1 class="text-display font-body text-fg-strong text-balance">{language.t("error.page.title")}</h1>
          <p class="text-h2 font-body text-fg-base text-balance">{language.t("error.page.description")}</p>
        </div>

        <Show when={knownError()}>
          {(known) => (
            <div class="mt-8 flex flex-col gap-2">
              <div class="text-h3 text-fg-strong">{known().title}</div>
              <p class="text-body text-fg-weak leading-relaxed">{known().description}</p>
            </div>
          )}
        </Show>

        <div class="mt-10 flex flex-col items-start gap-5">
          <Show
            when={platform.checkUpdate && store.version}
            fallback={
              <Button onClick={platform.restart}>
                {language.t("error.page.action.restart")}
              </Button>
            }
          >
            <Button onClick={installUpdate}>
              {language.t("error.page.action.updateTo", { version: store.version ?? "" })}
            </Button>
          </Show>
          <div class="flex items-center gap-2 text-body text-fg-base">
            <Show
              when={platform.checkUpdate && store.version}
              fallback={
                <Show when={platform.checkUpdate}>
                  <button
                    type="button"
                    class="hover:text-fg-strong transition-colors disabled:opacity-50"
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
              <button type="button" class="hover:text-fg-strong transition-colors" onClick={platform.restart}>
                {language.t("error.page.action.restart")}
              </button>
            </Show>
            <button
              type="button"
              class="hover:text-fg-strong transition-colors disabled:opacity-50"
              onClick={() => void prepareDiagnostics()}
              disabled={store.reporting}
            >
              {store.reporting ? language.t("error.page.report.preparing") : language.t("error.page.report.action")}
            </button>
          </div>
        </div>

        <Show when={store.review}>
          {(review) => (
            <div class="mt-8 max-w-[420px] rounded-lg ring-1 ring-border bg-bg-cream/40 pt-4">
              <h2 class="px-5 pb-1 text-h3 text-fg-strong">
                {language.t(review().hasForm ? "diagnostics.review.title.ready" : "diagnostics.review.title.saved")}
              </h2>
              <DiagnosticsReviewBody
                result={review()}
                platform={platform}
                language={language}
                onDone={() => setStore("review", undefined)}
              />
            </div>
          )}
        </Show>

        <Show when={store.actionError}>
          {(message) => <p class="mt-6 text-caption text-error">{message()}</p>}
        </Show>
        <Show when={store.actionMessage}>
          {(message) => <p class="mt-6 text-caption text-fg-weak">{message()}</p>}
        </Show>

        <details class="group mt-16">
          <summary class="cursor-pointer select-none text-body text-fg-weak hover:text-fg-base transition-colors list-none flex items-center gap-2 [&::-webkit-details-marker]:hidden">
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
            <div class="flex items-center gap-2 text-caption text-fg-weaker">
              <Show when={platform.version}>
                {(version) => (
                  <>
                    <span>{language.t("error.page.version", { version: version() })}</span>
                  </>
                )}
              </Show>
              <button
                type="button"
                class="hover:text-fg-weak transition-colors"
                onClick={() => platform.openLink(PAWWORK_GITHUB_ISSUE_URL)}
              >
                {language.t("error.page.report.githubFallback")}
              </button>
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}
