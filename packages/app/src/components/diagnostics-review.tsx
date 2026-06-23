import { Show, createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import type { useDialog } from "@opencode-ai/ui/context/dialog"
import type { useLanguage } from "@/context/language"
import type { Platform } from "@/context/platform"
import type { PrepareReportResult, ReportProblemInput, RevealReportResult, SubmitReportResult } from "@/desktop-api-contract"

type ReadyReport = Extract<PrepareReportResult, { status: "ready" }>
type Language = Pick<ReturnType<typeof useLanguage>, "t">
type ReviewPlatform = Pick<Platform, "prepareReport" | "revealReport" | "submitReport">
type DialogControl = Pick<ReturnType<typeof useDialog>, "show" | "close">

/**
 * The non-optional actions the review body needs. The desktop bridge wires
 * prepare/reveal/submit together, so we resolve them once at the entry boundary
 * and hand the body a settled pair — it never has to guard a half-present
 * platform where a missing `submitReport` would `await undefined` and silently
 * close the review as if it had been sent.
 */
export type ReviewActions = {
  revealReport: (reportId: string) => Promise<RevealReportResult>
  submitReport: (reportId: string) => Promise<SubmitReportResult>
}

export function reviewActionsFrom(platform: ReviewPlatform): ReviewActions | undefined {
  if (!platform.prepareReport || !platform.revealReport || !platform.submitReport) return undefined
  return { revealReport: platform.revealReport, submitReport: platform.submitReport }
}

function Row(props: { label: string; value?: string }) {
  return (
    <div class="flex items-baseline justify-between gap-4">
      <span class="text-body text-fg-base">{props.label}</span>
      <Show when={props.value}>
        <span class="text-body text-fg-weak tabular-nums">{props.value}</span>
      </Show>
    </div>
  )
}

function ContentsList(props: { result: ReadyReport; language: Language }) {
  const t = props.language.t
  const c = () => props.result.contents
  return (
    <div class="flex flex-col gap-2 rounded-lg bg-fg-base/[0.035] px-3.5 py-3">
      <Row label={t("diagnostics.review.contents.environment")} />
      <Show when={c().logLines !== null}>
        <Row label={t("diagnostics.review.contents.logs")} value={t("diagnostics.review.contents.logs.value", { count: c().logLines ?? 0 })} />
      </Show>
      <Show when={c().sessionMessages !== null}>
        <Row label={t("diagnostics.review.contents.session")} value={t("diagnostics.review.contents.session.value", { count: c().sessionMessages ?? 0 })} />
      </Show>
      <Show when={(c().rendererEvents ?? 0) > 0}>
        <Row label={t("diagnostics.review.contents.renderer")} value={t("diagnostics.review.contents.renderer.value", { count: c().rendererEvents ?? 0 })} />
      </Show>
      <Show when={c().rendererError}>
        <Row label={t("diagnostics.review.contents.error")} value={t("diagnostics.review.contents.error.value")} />
      </Show>
    </div>
  )
}

/**
 * The review body, shared by the menu's dialog and the error page's inline panel.
 * Lists what the package contains, states the privacy caveat, and offers reveal /
 * submit. Reveal does not close the surface; submit and cancel/done end it.
 */
export function DiagnosticsReviewBody(props: {
  result: ReadyReport
  actions: ReviewActions
  language: Language
  onDone: () => void
}) {
  const t = props.language.t
  const [submitting, setSubmitting] = createSignal(false)
  const [fallback, setFallback] = createSignal<{ feedbackUrl: string; summary: string }>()
  const [copied, setCopied] = createSignal(false)
  const [stale, setStale] = createSignal(false)
  const [failed, setFailed] = createSignal(false)

  const reveal = async () => {
    // Reveal can fail invisibly in the main process (stale id, or the OS handler declines), so it
    // returns an explicit result — surface stale/failed in the notice area instead of a silent no-op.
    // A rare IPC-layer rejection is caught here too so it never becomes an unhandled rejection.
    setFailed(false)
    setStale(false)
    try {
      const result = await props.actions.revealReport(props.result.reportId)
      if (result.status === "stale") setStale(true)
      else if (result.status === "failed") setFailed(true)
    } catch {
      setFailed(true)
    }
  }

  const submit = async () => {
    if (submitting()) return
    setSubmitting(true)
    setFailed(false)
    try {
      const result = await props.actions.submitReport(props.result.reportId)
      if (result.status === "form-fallback") {
        setFallback({ feedbackUrl: result.feedbackUrl, summary: result.summary })
        return
      }
      if (result.status === "stale") {
        // A newer prepare replaced this package; keep the surface open with a
        // clear notice instead of silently closing the submit entry.
        setStale(true)
        return
      }
      props.onDone()
    } catch {
      // IPC rejected — keep the dialog open with a recoverable notice rather than failing silently.
      setFailed(true)
    } finally {
      setSubmitting(false)
    }
  }

  const copySummary = async () => {
    const summary = fallback()?.summary
    if (!summary || !navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(summary)
      setCopied(true)
    } catch {
      // ignore — the link is still shown for manual submission
    }
  }

  return (
    <div class="flex flex-col gap-3.5 px-5 pb-5">
      <ContentsList result={props.result} language={props.language} />

      <p class="text-body text-fg-weak leading-relaxed">
        {t(props.result.hasForm ? "diagnostics.review.notice.upload" : "diagnostics.review.notice.share")}
      </p>

      <Show
        when={fallback()}
        fallback={
          <div class="flex flex-col gap-2.5">
            <Show when={stale()}>
              <p class="text-body text-error leading-relaxed">{t("diagnostics.review.stale")}</p>
            </Show>
            <Show when={failed()}>
              <p class="text-body text-error leading-relaxed">{t("diagnostics.review.actionFailed")}</p>
            </Show>
            <div class="flex justify-end gap-2">
              <Show when={props.result.hasForm} fallback={<Button variant="ghost" onClick={() => props.onDone()}>{t("diagnostics.review.action.done")}</Button>}>
                <Button variant="ghost" onClick={() => props.onDone()} disabled={submitting()}>
                  {t("common.cancel")}
                </Button>
              </Show>
              <Button variant={props.result.hasForm ? "secondary" : "primary"} onClick={reveal}>
                {t("diagnostics.review.action.reveal")}
              </Button>
              <Show when={props.result.hasForm}>
                <Button variant="primary" onClick={submit} disabled={submitting()}>
                  {t("diagnostics.review.action.submit")}
                </Button>
              </Show>
            </div>
          </div>
        }
      >
        {(state) => (
          <div class="flex flex-col gap-2.5">
            <p class="text-body text-fg-weak leading-relaxed">{t("diagnostics.review.formFallback")}</p>
            <div class="rounded-md ring-1 ring-border bg-bg-cream/40 px-3 py-2">
              <span class="block text-caption font-mono text-fg-base break-all select-text">{state().feedbackUrl}</span>
            </div>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" onClick={copySummary}>
                {copied() ? t("diagnostics.review.formFallback.copied") : t("diagnostics.review.formFallback.copy")}
              </Button>
              <Button variant="primary" onClick={() => props.onDone()}>
                {t("diagnostics.review.action.done")}
              </Button>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

function DialogDiagnosticsReview(props: {
  result: ReadyReport
  actions: ReviewActions
  language: Language
  dialog: Pick<DialogControl, "close">
}) {
  const title = () =>
    props.language.t(props.result.hasForm ? "diagnostics.review.title.ready" : "diagnostics.review.title.saved")
  return (
    <Dialog title={title()} fit class="w-full max-w-[380px] mx-auto">
      <DiagnosticsReviewBody
        result={props.result}
        actions={props.actions}
        language={props.language}
        onDone={() => props.dialog.close()}
      />
    </Dialog>
  )
}

/**
 * Prepare a diagnostics package and open the review dialog (menu entry point).
 * On a preparation failure the package could not be saved, so we surface a toast
 * with an optional copy of the redacted summary so feedback is still possible.
 */
export async function openDiagnosticsReview(
  deps: { platform: ReviewPlatform; dialog: DialogControl; language: Language },
  input?: ReportProblemInput,
): Promise<void> {
  const actions = reviewActionsFrom(deps.platform)
  if (!deps.platform.prepareReport || !actions) return
  const result = await deps.platform.prepareReport(input).catch(() => null)
  if (!result || result.status === "failed") {
    const summary = result?.status === "failed" ? result.summary : ""
    showToast({
      title: deps.language.t("diagnostics.review.prepareFailed"),
      variant: "error",
      actions:
        summary && navigator.clipboard?.writeText
          ? [
              {
                label: deps.language.t("diagnostics.review.formFallback.copy"),
                onClick: () => void navigator.clipboard.writeText(summary),
              },
            ]
          : undefined,
    })
    return
  }
  deps.dialog.show(() => (
    <DialogDiagnosticsReview
      result={result}
      actions={actions}
      language={deps.language}
      dialog={deps.dialog}
    />
  ))
}
