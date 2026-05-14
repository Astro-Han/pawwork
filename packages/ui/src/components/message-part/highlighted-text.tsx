import { createMemo, For } from "solid-js"
import type { FilePart } from "@opencode-ai/sdk/v2"

type HighlightSegment = { text: string; type?: "file" }

export function HighlightedText(props: { text: string; references: FilePart[] }) {
  // PawWork issue #239: `agents` prop removed. Past AgentPart mentions render as
  // plain text (no styled pill) because the picker concept is gone.
  const segments = createMemo(() => {
    const text = props.text

    const allRefs: { start: number; end: number; type: "file" }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({ start: r.source!.text!.start, end: r.source!.text!.end, type: "file" as const })),
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

  return <For each={segments()}>{(segment) => <span data-highlight={segment.type}>{segment.text}</span>}</For>
}
