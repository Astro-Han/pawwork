import { splitProps, type JSX } from "solid-js"

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  collapseThreshold?: number
}

export const resizeInteractionCompleteEvents = ["mouseup", "pointerup", "touchend"] as const

export const resizeInteractionCancelEvents = [
  "pointercancel",
  "touchcancel",
  "blur",
  "pagehide",
] as const

export const resizeInteractionStopEvents = [
  "mouseup",
  "pointerup",
  "pointercancel",
  "touchend",
  "touchcancel",
  "blur",
  "pagehide",
] as const

export type BodyInteractionLockReleaseReason = "complete" | "cancel" | "timeout"

export const resizeInteractionFallbackMs = 30_000

type BodyInteractionLockTarget = {
  style: {
    userSelect: string
    overflow: string
  }
}

export function createBodyInteractionLock(
  body: BodyInteractionLockTarget,
  options: {
    target?: EventTarget
    fallbackMs?: number
    onRelease?: (reason: BodyInteractionLockReleaseReason) => void
  } = {},
) {
  const target = options.target ?? window
  const fallbackMs = options.fallbackMs ?? resizeInteractionFallbackMs
  let active = false
  let fallback: ReturnType<typeof setTimeout> | undefined
  let previousUserSelect = ""
  let previousOverflow = ""

  const release = (reason: BodyInteractionLockReleaseReason) => {
    if (!active) return
    active = false
    body.style.userSelect = previousUserSelect
    body.style.overflow = previousOverflow
    if (fallback !== undefined) {
      clearTimeout(fallback)
      fallback = undefined
    }
    for (const event of resizeInteractionStopEvents) {
      target.removeEventListener(event, complete)
      target.removeEventListener(event, cancel)
    }
    options.onRelease?.(reason)
  }
  const complete = () => release("complete")
  const cancel = () => release("cancel")
  const timeout = () => release("timeout")

  return {
    start() {
      if (active) return
      active = true
      previousUserSelect = body.style.userSelect
      previousOverflow = body.style.overflow
      body.style.userSelect = "none"
      body.style.overflow = "hidden"
      for (const event of resizeInteractionCompleteEvents) {
        target.addEventListener(event, complete)
      }
      for (const event of resizeInteractionCancelEvents) {
        target.addEventListener(event, cancel)
      }
      fallback = setTimeout(timeout, fallbackMs)
    },
    stop: complete,
  }
}

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "size",
    "min",
    "max",
    "onResize",
    "onCollapse",
    "collapseThreshold",
    "class",
    "classList",
  ])

  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    const edge = local.edge ?? (local.direction === "vertical" ? "start" : "end")
    const start = local.direction === "horizontal" ? e.clientX : e.clientY
    const startSize = local.size
    let current = startSize

    const onMouseMove = (moveEvent: MouseEvent) => {
      const pos = local.direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
      const delta =
        local.direction === "vertical"
          ? edge === "end"
            ? pos - start
            : start - pos
          : edge === "start"
            ? start - pos
            : pos - start
      current = startSize + delta
      const clamped = Math.min(local.max, Math.max(local.min, current))
      local.onResize(clamped)
    }

    let finished = false
    const finish = (collapse: boolean) => {
      if (finished) return
      finished = true
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)

      const threshold = local.collapseThreshold ?? 0
      if (collapse && local.onCollapse && threshold > 0 && current < threshold) {
        local.onCollapse()
      }
    }

    const lock = createBodyInteractionLock(document.body, {
      onRelease: (reason) => finish(reason === "complete"),
    })

    const onMouseUp = () => {
      finish(true)
      lock.stop()
    }

    lock.start()
    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }

  return (
    <div
      {...rest}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={local.edge ?? (local.direction === "vertical" ? "start" : "end")}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      onMouseDown={handleMouseDown}
    />
  )
}
