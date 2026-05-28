import { Show, createEffect, createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DockCard, DockSegment } from "@opencode-ai/ui/dock-card"
import { PromptInput } from "@/components/prompt-input"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSync } from "@/context/sync"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { useSessionRouteKey } from "@/pages/session/session-layout"
import { SessionPermissionContent } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import type { FollowupDraft } from "@/components/prompt-input/followup-draft"

export function SessionComposerRegion(props: {
  state: SessionComposerState
  ready: boolean
  actionReady?: boolean
  abortReady?: boolean
  centered: boolean
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  onModeChange?: (mode: "normal" | "shell") => void
  displaySessionID?: string
  displaySessionKey?: string
  followup?: {
    queue: () => boolean
    items: { id: string; text: string }[]
    sending?: string
    edit?: { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] }
    onQueue: (draft: FollowupDraft) => void
    onAbort: () => void
    onSend: (id: string) => void
    onEdit: (id: string) => void
    onEditLoaded: () => void
  }
  revert?: {
    items: { id: string; text: string }[]
    restoring?: string
    disabled?: boolean
    onRestore: (id: string) => void
  }
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  const navigate = useNavigate()
  const prompt = usePrompt()
  const language = useLanguage()
  const route = useSessionRouteKey()
  const sync = useSync()
  const displaySessionID = () => props.displaySessionID
  const displaySessionKey = () => props.displaySessionKey

  const handoffPrompt = createMemo(() => {
    const key = displaySessionKey()
    return key ? getSessionHandoff(key)?.prompt : undefined
  })
  const info = createMemo(() => (displaySessionID() ? sync.session.get(displaySessionID()!) : undefined))
  const parentID = createMemo(() => info()?.parentID)
  const child = createMemo(() => !!parentID())
  const showComposer = createMemo(() => !!props.state.permissionRequest() || !props.state.blocked() || child())

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    const key = displaySessionKey()
    if (!key) return
    setSessionHandoff(key, { prompt: previewPrompt() })
  })

  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))

  const dockKind = createMemo(() => {
    if (props.state.questionRequest()) return "question"
    if (props.state.permissionRequest()) return "permission"
    if (rolled()) return "revert"
    if (props.followup?.items.length) return "followup"
    if (showComposer()) return "prompt"
    return "composer"
  })

  const openParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${route.params.dir}/session/${id}`)
  }

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      data-variant="session"
      data-dock-kind={dockKind()}
      class="w-full flex flex-col justify-center items-center pointer-events-none absolute inset-x-0 bottom-0 pb-6"
    >
      <div
        data-component="session-composer-column"
        classList={{
          "w-full pointer-events-auto px-4 md:px-3": true,
          "md:max-w-[720px] md:mx-auto 2xl:max-w-[920px]": props.centered,
        }}
      >
        <Show when={props.state.questionRequest()} keyed>
          {(request) => (
            <div>
              <SessionQuestionDock request={request} onSubmit={props.onResponseSubmit} />
            </div>
          )}
        </Show>

        <Show when={showComposer()}>
          <Show
            when={prompt.ready()}
            fallback={
              <DockCard>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <SessionRevertDock
                      items={revert.items}
                      restoring={revert.restoring}
                      disabled={revert.disabled}
                      onRestore={revert.onRestore}
                    />
                  )}
                </Show>
                {/* Permission requests can arrive while prompt is still
                  hydrating; render them here too so the user can approve or
                  deny without waiting for prompt.ready(). */}
                <Show
                  when={props.state.permissionRequest()}
                  keyed
                  fallback={
                    <DockSegment class="w-full min-h-32 md:min-h-40 px-4 py-3 text-body text-fg-weak whitespace-pre-wrap pointer-events-none">
                      {handoffPrompt() || language.t("prompt.loading")}
                    </DockSegment>
                  }
                >
                  {(request) => (
                    <SessionPermissionContent
                      request={request}
                      responding={props.state.permissionResponding()}
                      onDecide={(response) => {
                        props.onResponseSubmit()
                        props.state.decide(response)
                      }}
                    />
                  )}
                </Show>
              </DockCard>
            }
          >
            <div class="relative z-30">
              <DockCard class="overflow-visible!">
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <SessionRevertDock
                      items={revert.items}
                      restoring={revert.restoring}
                      disabled={revert.disabled}
                      onRestore={revert.onRestore}
                    />
                  )}
                </Show>
                <Show when={props.followup?.items.length}>
                  <SessionFollowupDock
                    items={props.followup!.items}
                    sending={props.followup!.sending}
                    onSend={props.followup!.onSend}
                    onEdit={props.followup!.onEdit}
                  />
                </Show>
                <Show
                  when={props.state.permissionRequest()}
                  keyed
                  fallback={
                    <Show
                      when={child()}
                      fallback={
                        <Show when={!props.state.blocked()}>
                          <PromptInput
                            ref={props.inputRef}
                            sessionID={displaySessionID()}
                            sessionIDControlled={true}
                            newSessionWorktree={props.newSessionWorktree}
                            onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                            edit={props.followup?.edit}
                            onEditLoaded={props.followup?.onEditLoaded}
                            shouldQueue={props.followup?.queue}
                            onQueue={props.followup?.onQueue}
                            onAbort={props.followup?.onAbort}
                            onSubmit={props.onSubmit}
                            onModeChange={props.onModeChange}
                            actionReady={() => props.actionReady ?? true}
                            abortReady={() => props.abortReady ?? props.actionReady ?? true}
                          />
                        </Show>
                      }
                    >
                      <DockSegment ref={props.inputRef} class="w-full p-3 text-h2 font-body text-fg-weak">
                        <span>{language.t("session.child.promptDisabled")} </span>
                        <Show when={parentID()}>
                          <button
                            type="button"
                            class="text-fg-base transition-colors hover:text-fg-strong"
                            onClick={openParent}
                          >
                            {language.t("session.child.backToParent")}
                          </button>
                        </Show>
                      </DockSegment>
                    </Show>
                  }
                >
                  {(request) => (
                    <SessionPermissionContent
                      request={request}
                      responding={props.state.permissionResponding()}
                      onDecide={(response) => {
                        props.onResponseSubmit()
                        props.state.decide(response)
                      }}
                    />
                  )}
                </Show>
              </DockCard>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
