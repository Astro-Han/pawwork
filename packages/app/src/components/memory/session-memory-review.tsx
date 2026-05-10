import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createResource, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type MemoryState = {
  disabled?: boolean
  status?: "ok" | "safe_mode"
}

type MemoryError = {
  error?: string
  reason?: string
}

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

const memoryError = (value: unknown): MemoryError | undefined => {
  if (!value || typeof value !== "object") return undefined
  if ("error" in value || "reason" in value) return value as MemoryError
  if ("data" in value) return memoryError((value as { data?: unknown }).data)
  return undefined
}

export function SessionMemoryReview(props: { sessionID?: string; visible: boolean }) {
  const language = useLanguage()
  const sdk = useSDK()
  const [draft, setDraft] = createSignal("")
  const [dismissed, setDismissed] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [reviewState] = createResource(
    () => (props.visible && props.sessionID ? props.sessionID : undefined),
    async () => {
      const result = await sdk.client.memory.reviewState()
      return (result.data ?? {}) as MemoryState
    },
  )

  const show = () => props.visible && !dismissed() && reviewState.latest?.disabled === false && reviewState.latest?.status === "ok"

  createEffect(() => {
    props.sessionID
    setDraft("")
    setDismissed(false)
  })

  const accept = async () => {
    const text = draft().trim()
    if (!text || saving()) return
    setSaving(true)
    try {
      const result = await sdk.client.memory.acceptProposal({ memoryProposalInput: { text, scope: "project" } })
      const blocked = memoryError(result.error)
      if (blocked?.error === "memory_disabled" || blocked?.error === "memory_safe_mode") {
        setDraft("")
        setDismissed(true)
        showToast({
          variant: "subtle",
          title: language.t("memory.review.blocked"),
          description: language.t(blocked.error === "memory_disabled" ? "memory.review.blockedDisabled" : "memory.review.blockedSafeMode"),
        })
        return
      }
      const state = (result.data ?? {}) as MemoryState
      if (state.disabled || state.status === "safe_mode") {
        setDraft("")
        setDismissed(true)
        showToast({
          variant: "subtle",
          title: language.t("memory.review.blocked"),
          description: language.t(state.disabled ? "memory.review.blockedDisabled" : "memory.review.blockedSafeMode"),
        })
        return
      }
      setDraft("")
      setDismissed(true)
      showToast({
        variant: "success",
        title: language.t("memory.review.saved"),
        description: language.t("memory.review.savedDescription"),
      })
    } catch (error) {
      const blocked = memoryError(error)
      if (blocked?.error === "memory_disabled" || blocked?.error === "memory_safe_mode") {
        setDraft("")
        setDismissed(true)
        showToast({
          variant: "subtle",
          title: language.t("memory.review.blocked"),
          description: language.t(blocked.error === "memory_disabled" ? "memory.review.blockedDisabled" : "memory.review.blockedSafeMode"),
        })
        return
      }
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Show when={show()}>
      <section
        data-component="session-memory-review"
        class="mx-3 mb-2 rounded-lg border border-border bg-bg-panel p-3 shadow-sm"
      >
        <div class="mb-2 text-13-medium text-fg-strong">{language.t("memory.review.title")}</div>
        <textarea
          data-action="session-memory-review-text"
          class="min-h-[72px] w-full rounded border border-border bg-bg-base p-2 text-13-regular text-fg-strong"
          value={draft()}
          placeholder={language.t("memory.review.placeholder")}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <div class="mt-2 flex justify-end gap-2">
          <Button
            size="small"
            onClick={() => {
              setDismissed(true)
            }}
          >
            {language.t("memory.review.dismiss")}
          </Button>
          <Button size="small" variant="primary" onClick={accept} disabled={!draft().trim() || saving()}>
            {language.t("memory.review.accept")}
          </Button>
        </div>
      </section>
    </Show>
  )
}
