import { Show } from "solid-js"
import CommandDefault from "../assets/icons/command-default.svg?raw"
import { icons } from "./icon"
import "./command-icon.css"

// The skill glyph lives in the chrome icon registry (icon.tsx) as inner SVG
// content for a 0 0 20 20 viewBox; wrap it into a full SVG so the command-icon
// system (input pill + sent bubble) can resolve "skill" the same way it does
// "command". The .command-icon CSS sizes it to 16×16 regardless of viewBox.
const REGISTRY: Record<string, string> = {
  command: CommandDefault,
  skill: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">${icons.skill}</svg>`,
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
