import { createMemo, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type {
  MessagePartProps,
  PartComponent,
  ToolComponent,
} from "./message-part-types"

/**
 * Slice 11b.1: the part and tool registries used to live at the top of
 * `message-part.tsx`. They are extracted here so the renderer files and
 * tool category files can register themselves through side-effect
 * imports without the registry definition reaching for them in turn —
 * the typical foundation for a registry/plugin shape.
 *
 * Public contract preserved through back-compat re-exports in
 * `message-part.tsx`.
 *
 *   `PART_MAPPING`            mutable registry, keyed by part `type`
 *   `registerPartComponent`   convenience setter (preferred over direct
 *                             `PART_MAPPING[...] = ...` from new code)
 *   `Part`                    dispatcher component looking up the
 *                             registered renderer for a given part
 *
 *   `registerTool`            register a per-tool renderer
 *   `getTool`                 look up the renderer for a given tool name
 *   `ToolRegistry`            alias object with `.register` / `.render`
 *                             — kept because `BasicTool` / `GenericTool`
 *                             callsites use the object form
 */

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <Dynamic
        component={component()}
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        turnDurationMs={props.turnDurationMs}
      />
    </Show>
  )
}

const toolState: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  toolState[input.name] = input
  return input
}

export function getTool(name: string) {
  return toolState[name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}
