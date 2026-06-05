import { createMemo, type ComponentProps } from "solid-js"
import { SessionComposerRegion, type createSessionComposerState } from "@/pages/session/composer"

type ComposerRegionProps = ComponentProps<typeof SessionComposerRegion>

export function SessionPageComposerRegion(props: {
  state: ReturnType<typeof createSessionComposerState>
  opening?: boolean
  ready: boolean
  actionReady?: boolean
  abortReady?: boolean
  displaySessionID?: string
  displaySessionKey?: string
  centered: boolean
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  onModeChange?: (mode: "normal" | "shell") => void
  followup?: ComposerRegionProps["followup"]
  revert?: ComposerRegionProps["revert"]
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  const content = createMemo(() =>
    props.opening ? (
      <SessionOpeningComposerPlaceholder centered={props.centered} setPromptDockRef={props.setPromptDockRef} />
    ) : (
      <SessionComposerRegion {...props} />
    ),
  )

  return <>{content()}</>
}

function SessionOpeningComposerPlaceholder(props: {
  centered: boolean
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      data-variant="session"
      data-dock-kind="composer"
      data-state="opening-placeholder"
      aria-hidden="true"
      class="w-full pointer-events-none absolute inset-x-0 bottom-0 box-border"
      style={{ height: "var(--composer-dock-height, 112px)" }}
    >
      <div
        data-component="session-composer-column"
        data-state="opening-placeholder"
        classList={{
          "h-full w-full px-4 md:px-3": true,
          "md:max-w-[720px] md:mx-auto 2xl:max-w-[920px]": props.centered,
        }}
      />
    </div>
  )
}
