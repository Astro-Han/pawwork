import { marked, type Tokens } from "marked"
import remend from "remend"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live"
  /**
   * `stable: true` means the block's `raw` boundary is closed at the lexer
   * level and won't be re-shaped by future streaming tokens. The renderer
   * uses this to skip morphdom on already-rendered head blocks: only the
   * dirty tail block needs to re-parse / re-decorate / re-diff every flush.
   *
   * Reference-style markdown (`refs(text)`) and single-token texts stay as
   * one dirty block — splitting them would risk orphaning inline tokens
   * that resolve against later definitions.
   */
  stable: boolean
}

function refs(text: string) {
  return /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return [{ raw: text, src: text, mode: "full", stable: true }]
  const src = heal(text)
  if (refs(text)) return [{ raw: text, src, mode: "live", stable: false }]
  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src, mode: "live", stable: false }]
  const last = tokens[tail]
  if (!last) return [{ raw: text, src, mode: "live", stable: false }]
  // Special case: an unfinished trailing fenced code block is split off so
  // the fence's still-streaming content doesn't drag the closed prose above
  // back through full re-parse on every flush. The head retains its lexer
  // boundary; the dirty tail is just the open code fence.
  if (last.type === "code" && open((last as Tokens.Code).raw)) {
    const code = last as Tokens.Code
    const head = tokens
      .slice(0, tail)
      .map((token) => token.raw)
      .join("")
    if (!head) return [{ raw: code.raw, src: code.raw, mode: "live", stable: false }]
    return [
      { raw: head, src: heal(head), mode: "live", stable: true },
      { raw: code.raw, src: code.raw, mode: "live", stable: false },
    ]
  }
  // General multi-token streaming: peel the last non-space token off as the
  // dirty tail. Everything before it has a closed lexer boundary and stays
  // stable while the tail keeps growing — the renderer can skip morphdom on
  // the head wrapper as long as its hash holds.
  if (tail >= 1) {
    const head = tokens
      .slice(0, tail)
      .map((token) => token.raw)
      .join("")
    if (head) {
      const tailRaw = tokens
        .slice(tail)
        .map((token) => token.raw)
        .join("")
      return [
        { raw: head, src: heal(head), mode: "live", stable: true },
        { raw: tailRaw, src: heal(tailRaw), mode: "live", stable: false },
      ]
    }
  }
  return [{ raw: text, src, mode: "live", stable: false }]
}
