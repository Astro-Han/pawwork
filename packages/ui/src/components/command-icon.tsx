import { Show } from "solid-js"
import CommandDefault from "../assets/icons/command-default.svg?raw"
import "./command-icon.css"

const REGISTRY: Record<string, string> = {
  command: CommandDefault,
}

export function CommandIcon(props: { icon: string }) {
  const svg = () => REGISTRY[props.icon] ?? REGISTRY.command
  return (
    <Show when={svg()}>
      <span class="command-icon" data-slot="command-icon" innerHTML={svg()} aria-hidden="true" />
    </Show>
  )
}
