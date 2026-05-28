import { render } from "solid-js/web"
import { SessionOpeningSkeleton } from "@/pages/session/session-opening-skeleton"

export function mountSessionOpeningSkeletonFixture(target: HTMLElement) {
  target.innerHTML = ""
  target.className = "min-h-screen bg-bg-base text-fg-base"

  const shell = document.createElement("div")
  shell.className = "relative mx-auto flex h-[720px] max-w-[1040px] flex-col overflow-hidden border-x border-border-weak"
  target.append(shell)

  const header = document.createElement("div")
  header.className = "h-12 shrink-0 border-b border-border-weak bg-bg-base"
  shell.append(header)

  const body = document.createElement("div")
  body.className = "relative min-h-0 flex-1"
  shell.append(body)

  render(
    () => <SessionOpeningSkeleton visible={true} transitioning={true} openingLabel="Opening session..." />,
    body,
  )
}
