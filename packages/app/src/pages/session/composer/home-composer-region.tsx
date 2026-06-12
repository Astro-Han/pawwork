import { Show, createEffect, createMemo } from "solid-js"
import { DockCard, DockSegment } from "@opencode-ai/ui/dock-card"
import { PromptInput } from "@/components/prompt-input"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { useSessionRouteKey } from "@/pages/session/session-layout"

export type HomeComposerRegionProps = {
  inputRef: (el: HTMLDivElement) => void
  actionReady: boolean
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onModeChange?: (mode: "normal" | "shell") => void
  setPromptDockRef: (el: HTMLDivElement) => void
}

export function HomeComposerRegion(props: HomeComposerRegionProps) {
  const prompt = usePrompt()
  const language = useLanguage()
  const route = useSessionRouteKey()

  const handoffKey = route.layoutRouteKey
  const handoffPrompt = createMemo(() => {
    const key = handoffKey()
    return key ? getSessionHandoff(key)?.prompt : undefined
  })

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "skill") return `/${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "attachment") return `[file:${part.path}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    const key = handoffKey()
    if (!key) return
    setSessionHandoff(key, { prompt: previewPrompt() })
  })

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      data-variant="home"
      data-dock-kind="prompt"
      class="w-full flex flex-col justify-center items-center pointer-events-none py-0 bg-transparent text-left"
    >
      <div
        data-component="session-composer-column"
        class="w-full pointer-events-auto px-3 md:max-w-[720px] md:mx-auto 2xl:max-w-[920px]"
      >
        <Show
          when={prompt.ready()}
          fallback={
            <DockCard>
              <DockSegment class="w-full min-h-32 md:min-h-40 px-4 py-3 text-body text-fg-weak whitespace-pre-wrap pointer-events-none">
                {handoffPrompt() || language.t("prompt.loading")}
              </DockSegment>
            </DockCard>
          }
        >
          <div class="relative z-30">
            <DockCard class="overflow-visible!">
              <PromptInput
                ref={props.inputRef}
                homeMode
                newSessionWorktree={props.newSessionWorktree}
                onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                onSubmit={props.onSubmit}
                onModeChange={props.onModeChange}
                actionReady={() => props.actionReady}
              />
            </DockCard>
          </div>
        </Show>
      </div>
    </div>
  )
}
