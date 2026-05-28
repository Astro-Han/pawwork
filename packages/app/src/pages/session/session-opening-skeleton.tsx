import type { Message } from "@opencode-ai/sdk/v2/client"

type SkeletonMessage = Pick<Message, "id" | "role">
type SkeletonTurn = { role: "user" | "assistant"; lineWidths: number[] }

const FALLBACK_TURNS: SkeletonTurn[] = [
  { role: "user", lineWidths: [22, 14] },
  { role: "assistant", lineWidths: [92, 78, 54] },
  { role: "user", lineWidths: [18] },
  { role: "assistant", lineWidths: [86, 70, 42] },
]
const MAX_SKELETON_TURNS = 6

export function SessionOpeningSkeleton(props: {
  visible: boolean
  transitioning: boolean
  openingLabel: string
  messages?: readonly SkeletonMessage[]
  overlay?: boolean
}) {
  const turns = () => buildSessionOpeningSkeletonTurns(props.messages)

  return (
    <div
      class="size-full bg-bg-base px-4 transition-opacity duration-[var(--duration-base)] ease-out motion-reduce:transition-none md:px-5"
      classList={{
        "absolute inset-0 z-10 pointer-events-none": props.overlay,
        "opacity-100": props.visible,
        "opacity-0": !props.visible,
      }}
      role="status"
      data-component="session-opening-state"
      data-state="skeleton"
      data-transitioning={props.transitioning ? "true" : "false"}
    >
      <span class="sr-only">{props.openingLabel}</span>
      <div
        class="mx-auto flex h-full w-full flex-col gap-6 pt-4 md:max-w-[800px] 2xl:max-w-[1000px]"
        aria-hidden="true"
      >
        {turns().map((turn) =>
          turn.role === "user" ? (
            <SkeletonUserTurn widths={turn.lineWidths} />
          ) : (
            <SkeletonAssistantTurn widths={turn.lineWidths} />
          ),
        )}
      </div>
    </div>
  )
}

export function buildSessionOpeningSkeletonTurns(messages?: readonly SkeletonMessage[]): SkeletonTurn[] {
  const visibleMessages =
    messages
      ?.filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-MAX_SKELETON_TURNS) ?? []
  if (visibleMessages.length === 0) return FALLBACK_TURNS

  return visibleMessages.map((message, index) => ({
    role: message.role === "user" ? "user" : "assistant",
    lineWidths:
      message.role === "user" ? userBubbleWidths(message, index) : assistantLineWidths(message, index),
  }))
}

function userBubbleWidths(message: SkeletonMessage, index: number): number[] {
  // ch 单位：inline-block 内容由字符数撑宽，让真实 user-message-text 的 inline-block
  // 自动按 max(width)+padding 算气泡尺寸，与真实文字消息几何一致。
  const seed = skeletonSeed(`${message.id}:${index}`)
  const count = 1 + (seed % 2)
  return Array.from({ length: count }, (_, line) => {
    const min = 10
    const max = 28
    const width = min + (((seed >> (line * 5)) + line * 7) % (max - min + 1))
    return line === 0 ? Math.max(width, 14) : width
  })
}

function assistantLineWidths(message: SkeletonMessage, index: number): number[] {
  // 百分比：assistant 容器 100%，每条灰条按 % 摆位，模拟段落不齐的右边缘。
  const seed = skeletonSeed(`${message.id}:${index}`)
  const count = 2 + (seed % 3)
  return Array.from({ length: count }, (_, line) => {
    const min = 42
    const max = 92
    const width = min + (((seed >> (line * 5)) + line * 17) % (max - min + 1))
    return line === 0 ? Math.max(width, 70) : width
  })
}

function skeletonSeed(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  return hash
}

function SkeletonUserTurn(props: { widths: number[] }) {
  return (
    <div data-component="user-message">
      <div data-slot="user-message-body">
        <div data-slot="user-message-text">
          {props.widths.map((width) => (
            <div
              data-slot="skeleton-line"
              data-shape="user"
              class="motion-safe:animate-pulse"
              style={{ width: `${width}ch` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function SkeletonAssistantTurn(props: { widths: number[] }) {
  return (
    <div data-component="assistant-message">
      {props.widths.map((width) => (
        <div
          data-slot="skeleton-line"
          data-shape="assistant"
          class="motion-safe:animate-pulse"
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  )
}
