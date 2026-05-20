import { Show } from "solid-js"
import CommandDefault from "../assets/icons/command-default.svg?raw"
import "./command-icon.css"

const REGISTRY: Record<string, string> = {
  command: CommandDefault,
}

/** Pure helper: resolves an icon key to its SVG string. No JSX or reactivity.
 *  Used by both the SolidJS component and the DOM-side input pill serializer. */
export function resolveCommandIconSvg(icon: string): string {
  return REGISTRY[icon] ?? REGISTRY.command
}

export function CommandIcon(props: { icon: string }) {
  const svg = () => resolveCommandIconSvg(props.icon)
  return (
    <Show when={svg()}>
      <span class="command-icon" data-slot="command-icon" innerHTML={svg()} aria-hidden="true" />
    </Show>
  )
}
