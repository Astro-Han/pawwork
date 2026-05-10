import { Show, createEffect, createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useSpring } from "@opencode-ai/ui/motion-spring"
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
import { DOCK_MOTION } from "@/pages/session/composer/motion"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import type { PawworkSkillName } from "@/components/session/pawwork-skill-meta"

export function SessionComposerRegion(props: {
  variant?: "session" | "home"
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
  selectedSkill?: () => PawworkSkillName | undefined
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
  const displaySessionID = createMemo(() => (props.variant === "session" ? props.displaySessionID : route.params.id))
  const displaySessionKey = createMemo(() =>
    props.variant === "session" ? props.displaySessionKey : route.layoutRouteKey(),
  )

  const handoffPrompt = createMemo(() => {
    const key = displaySessionKey()
    return key ? getSessionHandoff(key)?.prompt : undefined
  })
  const info = createMemo(() => (displaySessionID() ? sync.session.get(displaySessionID()!) : undefined))
  const parentID = createMemo(() => info()?.parentID)
  const child = createMemo(() => !!parentID())
  const home = createMemo(() => props.variant === "home")
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

  // Animate the Todo dock from 0 → visible when todos first appear (and back
  // out when the dock closes). Multiplied into max-height inside the segment
  // for slide-in + fed as dockProgress for content fade. Without this the
  // dock pops in the moment props.state.dock() flips true.
  const dockOpen = createMemo(() => props.state.dock())
  const dockSpring = useSpring(() => (dockOpen() ? 1 : 0), DOCK_MOTION)
  const dockProgress = createMemo(() => Math.max(0, Math.min(1, dockSpring())))
  const dockMounted = createMemo(() => dockOpen() || dockProgress() > 0.001)

  const openParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${route.params.dir}/session/${id}`)
  }

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      data-variant={home() ? "home" : "session"}
      classList={{
        "w-full flex flex-col justify-center items-center pointer-events-none": true,
        "absolute inset-x-0 bottom-0 pb-6": !home(),
        "py-0 bg-transparent": home(),
        "text-left": home(),
      }}
    >
      <div
        data-component="session-composer-column"
        classList={{
          "w-full pointer-events-auto": true,
          "px-4 md:px-3": !home(),
          "px-3": home(),
          "md:max-w-[720px] md:mx-auto 2xl:max-w-[920px]": props.centered || home(),
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
                    <DockSegment class="w-full min-h-32 md:min-h-40 px-4 py-3 text-13-regular text-fg-weak whitespace-pre-wrap pointer-events-none">
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
                <Show when={dockMounted()}>
                  <SessionTodoDock
                    sessionID={displaySessionID()}
                    todos={props.state.todos()}
                    collapseLabel={language.t("session.todo.collapse")}
                    expandLabel={language.t("session.todo.expand")}
                    dockProgress={dockProgress()}
                  />
                </Show>
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
                            homeMode={home()}
                            sessionID={displaySessionID()}
                            sessionIDControlled={!home()}
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
                            selectedSkill={props.selectedSkill}
                          />
                        </Show>
                      }
                    >
                      <DockSegment ref={props.inputRef} class="w-full p-3 text-16-regular text-fg-weak">
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
