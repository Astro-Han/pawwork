import { For, Show, createMemo, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import type { DockQuestionRequest } from "@/pages/session/blockers/use-session-blockers"
import { createQuestionResponseGuard, normalizeToolRespondError, resolveSkipAction } from "./question-tool-respond"
import { Mark, Option } from "./question-option"
import { cache, type DraftAnswer, type QuestionAnswer, type QuestionStore } from "./question-draft"
import { focusWithoutScrollingTimeline } from "./question-option-focus"
import { createQuestionAnswerEditing } from "./question-answer-editing"
import { createQuestionKeyboardNav } from "./question-keyboard-nav"

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
  const [store, setStore] = createStore<QuestionStore>({
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

  const canInteract = () => responseGuard.canInteract(props.request.id)

  const keyboardNav = createQuestionKeyboardNav({
    store,
    setStore,
    questions,
    count,
    canInteract,
    resolveFocusTarget: (index) => (index === options().length ? customRef : optsRef[index]),
    next: () => next(),
    reject: () => reject(),
  })

  onMount(() => {
    keyboardNav.focus(keyboardNav.pickFocus())
  })

  onCleanup(() => {
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
      keyboardNav.focus(keyboardNav.pickFocus(pending))
      return
    }
    // mutateAsync rethrows after onError(fail) handles the toast; swallow
    // the rejection here so the void-call site doesn't leak an unhandled
    // promise rejection on 404/409/422/network failures.
    reply(questions().map((_, i) => store.answers[i] ?? [])).catch(() => {})
  }

  const editing = createQuestionAnswerEditing({
    store,
    setStore,
    input,
    on,
    multi,
    optionCount: () => options().length,
    canInteract,
    focus: keyboardNav.focus,
  })

  const selectOption = (optIndex: number) => {
    if (!canInteract()) return

    if (optIndex === options().length) {
      if (!customAllowed()) return
      editing.customOpen()
      return
    }

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      setStore("editing", false)
      editing.toggle(opt.label)
      return
    }
    editing.pick(opt.label)
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
    editing.customToggle()
  }

  const next = () => {
    if (!canInteract()) return
    if (store.editing) editing.commitCustom()

    if (store.tab >= total() - 1) {
      submit()
      return
    }

    const tab = store.tab + 1
    setStore("tab", tab)
    setStore("editing", false)
    keyboardNav.focus(keyboardNav.pickFocus(tab))
  }

  const back = () => {
    if (!canInteract()) return
    if (store.tab <= 0) return
    const tab = store.tab - 1
    setStore("tab", tab)
    setStore("editing", false)
    keyboardNav.focus(keyboardNav.pickFocus(tab))
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
      keyboardNav.focus(keyboardNav.pickFocus(action.tab))
      return
    }

    submit()
  }

  return (
    <div
      data-component="dock-prompt"
      data-kind="question"
      ref={(el) => (root = el)}
      onKeyDown={keyboardNav.nav}
    >
      <div data-slot="question-header">
        <div data-slot="question-text">{question()?.question}</div>
        <Show when={total() > 1}>
          <span data-slot="question-header-seq">{summary()}</span>
        </Show>
      </div>
      <Show when={multi()}>
        <div data-slot="question-header-mode">{language.t("ui.question.multiHint")}</div>
      </Show>
      <div data-slot="question-options">
        <For each={options()}>
          {(opt, i) => (
            <Option
              multi={multi()}
              picked={editing.picked(opt.label)}
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
                onClick={editing.customOpen}
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
                editing.commitCustom()
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
                      keyboardNav.focus(options().length)
                      return
                    }
                    if ((e.metaKey || e.ctrlKey) && !e.altKey) return
                    if (e.key !== "Enter" || e.shiftKey) return
                    e.preventDefault()
                    editing.commitCustom()
                  }}
                  onInput={(e) => {
                    editing.customUpdate(e.currentTarget.value)
                    resizeInput(e.currentTarget)
                  }}
                />
              </span>
            </form>
          </Show>
        </Show>
      </div>
      <div data-slot="question-footer">
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
      </div>
    </div>
  )
}
