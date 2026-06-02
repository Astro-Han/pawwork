import { For, Show, createMemo, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import type { DockQuestionRequest } from "@/pages/session/blockers/use-session-blockers"
import { createQuestionResponseGuard, normalizeToolRespondError, resolveSkipAction } from "./question-tool-respond"
import { Mark, Option } from "./question-option"
import { cache, type DraftAnswer, type QuestionAnswer } from "./question-draft"
import { focusWithoutScrollingTimeline } from "./question-option-focus"

type QuestionRequestFingerprint = Pick<DockQuestionRequest, "id" | "sessionID" | "messageID" | "callID">

export function isSameQuestionRequest(
  left: QuestionRequestFingerprint | undefined,
  right: QuestionRequestFingerprint,
  errorRequestID?: string,
) {
  if (!left) return false
  if (left.sessionID !== right.sessionID || left.messageID !== right.messageID || left.callID !== right.callID)
    return false
  if (errorRequestID !== undefined && errorRequestID !== right.id) return false
  return left.id === right.id
}

export const SessionQuestionDock: Component<{ request: DockQuestionRequest; onSubmit: () => void }> = (props) => {
  const sdk = useSDK()
  const language = useLanguage()

  const questions = createMemo(() => props.request.questions)
  const total = createMemo(() => questions().length)

  const cached = cache.get(props.request.id)
  const [store, setStore] = createStore({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? ([] as DraftAnswer[]),
    custom: cached?.custom ?? ([] as string[]),
    customOn: cached?.customOn ?? ([] as boolean[]),
    editing: false,
    focus: 0,
  })

  let root: HTMLDivElement | undefined
  let customRef: HTMLButtonElement | undefined
  let optsRef: HTMLButtonElement[] = []
  let replied = false
  let locallySubmitted: QuestionRequestFingerprint | undefined
  const responseGuard = createQuestionResponseGuard(props.request.id)
  let focusFrame: number | undefined

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const on = createMemo(() => store.customOn[store.tab] === true)
  const multi = createMemo(() => question()?.multiple === true)
  const customAllowed = createMemo(() => question()?.custom !== false)
  const count = createMemo(() => options().length + (customAllowed() ? 1 : 0))

  const summary = createMemo(() => {
    const n = Math.min(store.tab + 1, total())
    return language.t("session.question.progress", { current: n, total: total() })
  })

  const customLabel = () => language.t("ui.messagePart.option.typeOwnAnswer")
  const customPlaceholder = () => language.t("ui.question.custom.placeholder")

  const last = createMemo(() => store.tab >= total() - 1)

  const customUpdate = (value: string, selected: boolean = on()) => {
    const prev = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)
    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = prev ? current.filter((item) => item.trim() !== prev) : current
        if (!next) return removed.length ? removed : undefined
        if (removed.some((item) => item.trim() === next)) return removed
        return [...removed, next]
      })
      return
    }

    setStore("answers", store.tab, next ? [next] : undefined)
  }

  const clamp = (i: number) => Math.max(0, Math.min(count() - 1, i))

  const pickFocus = (tab: number = store.tab) => {
    const list = questions()[tab]?.options ?? []
    const customOnTab = questions()[tab]?.custom !== false
    if (customOnTab && store.customOn[tab] === true) return list.length
    return Math.max(
      0,
      list.findIndex((item) => store.answers[tab]?.includes(item.label) ?? false),
    )
  }

  const focus = (i: number) => {
    const next = clamp(i)
    setStore("focus", next)
    if (store.editing) return
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      const el = next === options().length ? customRef : optsRef[next]
      focusWithoutScrollingTimeline(el)
    })
  }

  onMount(() => {
    focus(pickFocus())
  })

  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    if (replied) return
    const customByTab = (i: number) => questions()[i]?.custom !== false
    cache.set(props.request.id, {
      tab: store.tab,
      answers: Array.from({ length: total() }, (_, i) =>
        store.answers[i] === undefined ? undefined : [...store.answers[i]],
      ),
      // Iterate by total() to avoid leaving stale entries when a tab was never visited.
      custom: Array.from({ length: total() }, (_, i) => (customByTab(i) ? (store.custom[i] ?? "") : "")),
      customOn: Array.from({ length: total() }, (_, i) => (customByTab(i) ? (store.customOn[i] ?? false) : false)),
    })
  })

  const currentRequest = (): QuestionRequestFingerprint => ({
    id: props.request.id,
    sessionID: props.request.sessionID,
    messageID: props.request.messageID,
    callID: props.request.callID,
  })

  const complete = () => {
    responseGuard.confirm(props.request.id)
    replied = true
    cache.delete(props.request.id)
    props.onSubmit()
  }

  const canInteract = () => responseGuard.canInteract(props.request.id)

  const fail = (err: unknown): "completed" | "failed" => {
    const normalized = normalizeToolRespondError(err)
    if (normalized.type === "already_resolved") {
      if (isSameQuestionRequest(locallySubmitted, currentRequest(), normalized.requestID)) {
        complete()
        return "completed"
      }
      showToast({
        title: language.t("common.requestFailed"),
        description: language.t("session.question.error.alreadyAnswered"),
      })
      responseGuard.fail(props.request.id)
      locallySubmitted = undefined
      return "failed"
    }
    if (normalized.type === "stale_session") {
      showToast({
        title: language.t("common.requestFailed"),
        description: language.t("session.question.error.staleSession"),
      })
      responseGuard.fail(props.request.id)
      locallySubmitted = undefined
      return "failed"
    }
    if (normalized.type === "invalid_payload") {
      showToast({
        title: language.t("common.requestFailed"),
        description: normalized.detail || language.t("session.question.error.invalidPayload"),
      })
      responseGuard.fail(props.request.id)
      locallySubmitted = undefined
      return "failed"
    }
    showToast({
      title: language.t("common.requestFailed"),
      description: normalized.detail || language.t("session.question.error.unknown"),
    })
    responseGuard.fail(props.request.id)
    locallySubmitted = undefined
    return "failed"
  }

  const replyMutation = useMutation(() => ({
    mutationFn: async (answers: QuestionAnswer[]): Promise<void> => {
      locallySubmitted = currentRequest()
      await sdk.client.session.toolRespond({
        sessionID: props.request.sessionID,
        body: {
          kind: "submit",
          messageID: props.request.messageID,
          callID: props.request.callID,
          payload: { answers },
        },
      })
    },
    onSuccess: () => {
      complete()
    },
    onError: fail,
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: async (): Promise<void> => {
      locallySubmitted = currentRequest()
      await sdk.client.session.toolRespond({
        sessionID: props.request.sessionID,
        body: {
          kind: "dismiss",
          messageID: props.request.messageID,
          callID: props.request.callID,
        },
      })
    },
    onSuccess: () => {
      complete()
    },
    onError: fail,
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const reply = async (answers: QuestionAnswer[]) => {
    if (sending() || !responseGuard.begin(props.request.id)) return
    await replyMutation.mutateAsync(answers)
  }

  const reject = async () => {
    if (sending() || !responseGuard.begin(props.request.id)) return
    await rejectMutation.mutateAsync()
  }

  const settled = (i: number) => store.answers[i] !== undefined
  const firstUnsettled = () => questions().findIndex((_, i) => !settled(i))

  const submit = () => {
    const pending = firstUnsettled()
    if (pending >= 0) {
      setStore("tab", pending)
      setStore("editing", false)
      focus(pickFocus(pending))
      return
    }
    // mutateAsync rethrows after onError(fail) handles the toast; swallow
    // the rejection here so the void-call site doesn't leak an unhandled
    // promise rejection on 404/409/422/network failures.
    reply(questions().map((_, i) => store.answers[i] ?? [])).catch(() => {})
  }

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string, custom: boolean = false) => {
    setStore("answers", store.tab, [answer])
    if (custom) setStore("custom", store.tab, answer)
    if (!custom) setStore("customOn", store.tab, false)
    setStore("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) {
        const next = current.filter((item) => item !== answer)
        return next.length ? next : undefined
      }
      return [...current, answer]
    })
  }

  const customToggle = () => {
    if (!canInteract()) return
    setStore("focus", options().length)

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const next = !on()
    setStore("customOn", store.tab, next)
    if (next) {
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const value = input().trim()
    if (value) {
      setStore("answers", store.tab, (current = []) => {
        const next = current.filter((item) => item.trim() !== value)
        return next.length ? next : undefined
      })
    }
    setStore("editing", false)
    focus(options().length)
  }

  const customOpen = () => {
    if (!canInteract()) return
    setStore("focus", options().length)
    if (!on()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
  }

  const move = (step: number) => {
    if (store.editing || !canInteract()) return
    focus(store.focus + step)
  }

  const nav = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return

    if (event.key === "Escape") {
      event.preventDefault()
      reject().catch(() => {})
      return
    }

    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    if (mod && event.key === "Enter") {
      if (event.repeat) return
      event.preventDefault()
      next()
      return
    }

    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="question-options"]') : undefined
    if (store.editing) return
    if (!(target instanceof HTMLElement)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault()
      move(1)
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault()
      move(-1)
      return
    }

    if (event.key === "Home") {
      event.preventDefault()
      focus(0)
      return
    }

    if (event.key !== "End") return
    event.preventDefault()
    focus(count() - 1)
  }

  const selectOption = (optIndex: number) => {
    if (!canInteract()) return

    if (optIndex === options().length) {
      if (!customAllowed()) return
      customOpen()
      return
    }

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      setStore("editing", false)
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
    focus(options().length)
  }

  const resizeInput = (el: HTMLTextAreaElement) => {
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }

  const focusCustom = (el: HTMLTextAreaElement) => {
    setTimeout(() => {
      focusWithoutScrollingTimeline(el)
      resizeInput(el)
    }, 0)
  }

  const toggleCustomMark = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    customToggle()
  }

  const next = () => {
    if (!canInteract()) return
    if (store.editing) commitCustom()

    if (store.tab >= total() - 1) {
      submit()
      return
    }

    const tab = store.tab + 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const back = () => {
    if (!canInteract()) return
    if (store.tab <= 0) return
    const tab = store.tab - 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const skipCurrent = () => {
    if (!canInteract()) return
    setStore("answers", store.tab, [])
    setStore("custom", store.tab, "")
    setStore("customOn", store.tab, false)
    setStore("editing", false)

    const action = resolveSkipAction(store.tab, settled, total())
    if (action.type === "navigate") {
      setStore("tab", action.tab)
      focus(pickFocus(action.tab))
      return
    }

    submit()
  }

  const jump = (tab: number) => {
    if (!canInteract()) return
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  return (
    <DockPrompt
      kind="question"
      ref={(el) => (root = el)}
      onKeyDown={nav}
      header={
        <>
          <div data-slot="question-header-title">
            <span data-slot="question-header-seq">{summary()}</span>
            <span data-slot="question-header-mode">
              {multi() ? language.t("ui.question.multiHint") : language.t("ui.question.singleHint")}
            </span>
          </div>
          <div data-slot="question-progress">
            <For each={questions()}>
              {(_, i) => (
                <button
                  type="button"
                  data-slot="question-progress-segment"
                  data-active={i() === store.tab}
                  data-answered={settled(i())}
                  disabled={!canInteract()}
                  onClick={() => jump(i())}
                  aria-label={`${language.t("ui.tool.questions")} ${i() + 1}`}
                />
              )}
            </For>
          </div>
        </>
      }
      footer={
        <>
          <Button variant="ghost" disabled={!canInteract()} onClick={skipCurrent}>
            {language.t("session.question.skipCurrent")}
          </Button>
          <div data-slot="question-footer-actions">
            <Show when={store.tab > 0}>
              <Button variant="secondary" disabled={!canInteract()} onClick={back}>
                {language.t("ui.common.back")}
              </Button>
            </Show>
            <Button
              variant={last() ? "primary" : "secondary"}
              disabled={!canInteract()}
              onClick={next}
              aria-keyshortcuts="Meta+Enter Control+Enter"
            >
              {last() ? language.t("ui.common.submit") : language.t("ui.common.next")}
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="question-text">{question()?.question}</div>
      <div data-slot="question-options">
        <For each={options()}>
          {(opt, i) => (
            <Option
              multi={multi()}
              picked={picked(opt.label)}
              label={opt.label}
              description={opt.description}
              disabled={!canInteract()}
              ref={(el) => (optsRef[i()] = el)}
              onFocus={() => setStore("focus", i())}
              onClick={() => selectOption(i())}
            />
          )}
        </For>

        <Show when={customAllowed()}>
          <Show
            when={store.editing}
            fallback={
              <button
                type="button"
                ref={customRef}
                data-slot="question-option"
                data-custom="true"
                data-picked={on()}
                role={multi() ? "checkbox" : "radio"}
                aria-checked={on()}
                disabled={!canInteract()}
                onFocus={() => setStore("focus", options().length)}
                onClick={customOpen}
              >
                <Mark multi={multi()} picked={on()} onClick={toggleCustomMark} />
                <span data-slot="question-option-main">
                  <span data-slot="option-label">{customLabel()}</span>
                  <span data-slot="option-description">{input() || customPlaceholder()}</span>
                </span>
              </button>
            }
          >
            <form
              data-slot="question-option"
              data-custom="true"
              data-picked={on()}
              role={multi() ? "checkbox" : "radio"}
              aria-checked={on()}
              onMouseDown={(e) => {
                if (!canInteract()) {
                  e.preventDefault()
                  return
                }
                if (e.target instanceof HTMLTextAreaElement) return
                const input = e.currentTarget.querySelector('[data-slot="question-custom-input"]')
                if (input instanceof HTMLTextAreaElement) input.focus()
              }}
              onSubmit={(e) => {
                e.preventDefault()
                commitCustom()
              }}
            >
              <Mark multi={multi()} picked={on()} onClick={toggleCustomMark} />
              <span data-slot="question-option-main">
                <span data-slot="option-label">{customLabel()}</span>
                <textarea
                  ref={focusCustom}
                  data-slot="question-custom-input"
                  placeholder={customPlaceholder()}
                  value={input()}
                  rows={1}
                  disabled={!canInteract()}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault()
                      setStore("editing", false)
                      focus(options().length)
                      return
                    }
                    if ((e.metaKey || e.ctrlKey) && !e.altKey) return
                    if (e.key !== "Enter" || e.shiftKey) return
                    e.preventDefault()
                    commitCustom()
                  }}
                  onInput={(e) => {
                    customUpdate(e.currentTarget.value)
                    resizeInput(e.currentTarget)
                  }}
                />
              </span>
            </form>
          </Show>
        </Show>
      </div>
    </DockPrompt>
  )
}
