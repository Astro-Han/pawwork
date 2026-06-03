import { createMemo, For, Show } from "solid-js"
import type { FilePart, SkillPart } from "@opencode-ai/sdk/v2"
import { CommandIcon } from "../command-icon"

type HighlightSegment = { text: string; type?: "file" | "skill" }

export function HighlightedText(props: { text: string; references: FilePart[]; skills?: SkillPart[] }) {
  // PawWork issue #239: `agents` prop removed — past AgentPart mentions render as
  // plain text because the picker concept is gone. Inline skill chips, by
  // contrast, ARE highlighted: the "/name" token is colored like the leading
  // command mark, keyed off the skill part's source span in the flattened text.
  const segments = createMemo(() => {
    const text = props.text

    const allRefs: { start: number; end: number; type: "file" | "skill" }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({ start: r.source!.text!.start, end: r.source!.text!.end, type: "file" as const })),
      ...(props.skills ?? [])
        .filter((s) => s.source?.start !== undefined && s.source?.end !== undefined)
        .map((s) => ({ start: s.source!.start, end: s.source!.end, type: "skill" as const })),
    ].sort((a, b) => a.start - b.start)

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      result.push({ text: text.slice(ref.start, ref.end), type: ref.type })
      lastIndex = ref.end
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) })
    }

    return result
  })

  return (
    <For each={segments()}>
      {(segment) => (
        <span data-highlight={segment.type}>
          <Show when={segment.type === "skill"}>
            <CommandIcon icon="skill" />
          </Show>
          {segment.text}
        </span>
      )}
    </For>
  )
}
