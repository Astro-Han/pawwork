import type { Page } from "@playwright/test"

export type RuntimeClsSourceKind =
  | "primary-message-wrapper"
  | "primary-turn"
  | "residual-assistant-message"
  | "dock-or-scroll-recovery"
  | "other"

export type RuntimeClsSourceClassification = {
  kind: RuntimeClsSourceKind
  selector?: string
}

export type RuntimeClsTargetStyle = {
  messageID: string
  active: boolean
  contentVisibility: string
  containIntrinsicSize: string
}

export type RuntimeClsSourceRecord = RuntimeClsSourceClassification & {
  node: string
  ancestorChain: string[]
  previousRect?: RuntimeClsRect
  currentRect?: RuntimeClsRect
}

export type RuntimeClsShiftRecord = {
  action: string
  at: number
  value: number
  hadRecentInput: boolean
  sources: RuntimeClsSourceRecord[]
  scroll?: {
    top: number
    height: number
    client: number
    distanceFromBottom: number
  }
}

export type RuntimeClsProbeSnapshot = {
  action: string
  targetStyle?: RuntimeClsTargetStyle
  shifts: RuntimeClsShiftRecord[]
}

type RuntimeClsRect = {
  x: number
  y: number
  width: number
  height: number
}

type BrowserRuntimeClsWindow = Window & {
  __pawwork_runtime_cls_probe?: {
    start: (action: string, targetMessageID?: string) => RuntimeClsTargetStyle | undefined
    stop: () => RuntimeClsProbeSnapshot
  }
}

export const PRIMARY_RUNTIME_CLS_THRESHOLD = 0.02

export function classifyLayoutShiftSource(element: Element | null | undefined): RuntimeClsSourceClassification {
  if (!element) return { kind: "other" }

  const assistantMessage = element.closest('[data-component="assistant-message"]')
  if (assistantMessage) {
    return { kind: "residual-assistant-message", selector: '[data-component="assistant-message"]' }
  }

  const assistantContent = element.closest('[data-slot="session-turn-assistant-content"]')
  if (assistantContent) {
    return { kind: "residual-assistant-message", selector: '[data-slot="session-turn-assistant-content"]' }
  }

  const sessionTurn = element.closest('[data-component="session-turn"]')
  if (sessionTurn) return { kind: "primary-turn", selector: '[data-component="session-turn"]' }

  const messageWrapper = element.closest("[data-message-id]")
  if (messageWrapper) return { kind: "primary-message-wrapper", selector: "[data-message-id]" }

  const dockPrompt = element.closest('[data-component="dock-prompt"]')
  if (dockPrompt) return { kind: "dock-or-scroll-recovery", selector: '[data-component="dock-prompt"]' }

  const composerDock = element.closest('[data-component="session-prompt-dock"]')
  if (composerDock) return { kind: "dock-or-scroll-recovery", selector: '[data-component="session-prompt-dock"]' }

  return { kind: "other" }
}

export function hasPrimaryRuntimeClsShift(snapshot: RuntimeClsProbeSnapshot) {
  return snapshot.shifts.some(
    (shift) =>
      shift.value > PRIMARY_RUNTIME_CLS_THRESHOLD &&
      shift.sources.some((source) => source.kind === "primary-message-wrapper" || source.kind === "primary-turn"),
  )
}

export async function installRuntimeClsProbe(page: Page) {
  await page.addInitScript(() => {
    const win = window as BrowserRuntimeClsWindow
    if (win.__pawwork_runtime_cls_probe) return

    type RuntimeClsSourceKind =
      | "primary-message-wrapper"
      | "primary-turn"
      | "residual-assistant-message"
      | "dock-or-scroll-recovery"
      | "other"
    type RuntimeClsSourceClassification = { kind: RuntimeClsSourceKind; selector?: string }
    type RuntimeClsRect = { x: number; y: number; width: number; height: number }
    type RuntimeClsSourceRecord = RuntimeClsSourceClassification & {
      node: string
      ancestorChain: string[]
      previousRect?: RuntimeClsRect
      currentRect?: RuntimeClsRect
    }
    type RuntimeClsShiftRecord = {
      action: string
      at: number
      value: number
      hadRecentInput: boolean
      sources: RuntimeClsSourceRecord[]
      scroll?: { top: number; height: number; client: number; distanceFromBottom: number }
    }
    type RuntimeClsTargetStyle = {
      messageID: string
      active: boolean
      contentVisibility: string
      containIntrinsicSize: string
    }

    const maxEntries = 256
    let action = "idle"
    let armed = false
    let targetStyle: RuntimeClsTargetStyle | undefined
    const shifts: RuntimeClsShiftRecord[] = []

    const classify = (element: Element | null | undefined): RuntimeClsSourceClassification => {
      if (!element) return { kind: "other" }
      if (element.closest('[data-component="assistant-message"]')) {
        return { kind: "residual-assistant-message", selector: '[data-component="assistant-message"]' }
      }
      if (element.closest('[data-slot="session-turn-assistant-content"]')) {
        return { kind: "residual-assistant-message", selector: '[data-slot="session-turn-assistant-content"]' }
      }
      if (element.closest('[data-component="session-turn"]')) {
        return { kind: "primary-turn", selector: '[data-component="session-turn"]' }
      }
      if (element.closest("[data-message-id]"))
        return { kind: "primary-message-wrapper", selector: "[data-message-id]" }
      if (element.closest('[data-component="dock-prompt"]')) {
        return { kind: "dock-or-scroll-recovery", selector: '[data-component="dock-prompt"]' }
      }
      if (element.closest('[data-component="session-prompt-dock"]')) {
        return { kind: "dock-or-scroll-recovery", selector: '[data-component="session-prompt-dock"]' }
      }
      return { kind: "other" }
    }

    const describeElement = (element: Element | null | undefined) => {
      if (!element) return "<missing>"
      const attrs = [
        element.id ? `#${element.id}` : "",
        element.getAttribute("data-message-id") ? `[data-message-id=${element.getAttribute("data-message-id")}]` : "",
        element.getAttribute("data-component") ? `[data-component=${element.getAttribute("data-component")}]` : "",
        element.getAttribute("data-slot") ? `[data-slot=${element.getAttribute("data-slot")}]` : "",
        element.getAttribute("data-kind") ? `[data-kind=${element.getAttribute("data-kind")}]` : "",
      ]
        .filter(Boolean)
        .join("")
      return `${element.tagName.toLowerCase()}${attrs}`
    }

    const ancestorChain = (element: Element | null | undefined) => {
      const chain: string[] = []
      let current = element
      while (current && chain.length < 8) {
        chain.push(describeElement(current))
        current = current.parentElement
      }
      return chain
    }

    const rect = (input: DOMRectReadOnly | undefined): RuntimeClsRect | undefined => {
      if (!input) return undefined
      return { x: input.x, y: input.y, width: input.width, height: input.height }
    }

    const readScroll = () => {
      const list = document.querySelector('[data-slot="session-turn-list"]')
      const viewport = list?.closest('[data-component="scroll-viewport"]')
      if (!(viewport instanceof HTMLElement)) return undefined
      return {
        top: viewport.scrollTop,
        height: viewport.scrollHeight,
        client: viewport.clientHeight,
        distanceFromBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      }
    }

    const readTargetStyle = (messageID?: string): RuntimeClsTargetStyle | undefined => {
      const target = messageID
        ? document.querySelector(`[data-message-id="${CSS.escape(messageID)}"]`)
        : document.querySelector("[data-message-id]")
      if (!(target instanceof HTMLElement)) return undefined
      const style = getComputedStyle(target)
      const active = target.querySelector('[data-active="true"], [aria-busy="true"]') !== null
      return {
        messageID: target.getAttribute("data-message-id") ?? "",
        active,
        contentVisibility: style.contentVisibility,
        containIntrinsicSize: style.containIntrinsicSize,
      }
    }

    const supported = PerformanceObserver.supportedEntryTypes ?? []
    if (supported.includes("layout-shift")) {
      const observer = new PerformanceObserver((list) => {
        if (!armed) return
        for (const entry of list.getEntries() as Array<
          PerformanceEntry & {
            value?: number
            hadRecentInput?: boolean
            sources?: Array<{ node?: Node; previousRect?: DOMRectReadOnly; currentRect?: DOMRectReadOnly }>
          }
        >) {
          if (typeof entry.value !== "number") continue
          shifts.push({
            action,
            at: entry.startTime,
            value: entry.value,
            hadRecentInput: entry.hadRecentInput === true,
            sources: (entry.sources ?? []).map((source) => {
              const element = source.node instanceof Element ? source.node : undefined
              return {
                ...classify(element),
                node: describeElement(element),
                ancestorChain: ancestorChain(element),
                previousRect: rect(source.previousRect),
                currentRect: rect(source.currentRect),
              }
            }),
            scroll: readScroll(),
          })
          if (shifts.length > maxEntries) shifts.splice(0, shifts.length - maxEntries)
        }
      })
      try {
        observer.observe({ buffered: true, type: "layout-shift" })
      } catch {
        observer.disconnect()
      }
    }

    win.__pawwork_runtime_cls_probe = {
      start(nextAction, targetMessageID) {
        action = nextAction
        shifts.splice(0, shifts.length)
        targetStyle = readTargetStyle(targetMessageID)
        armed = true
        return targetStyle
      },
      stop() {
        armed = false
        return { action, targetStyle, shifts: shifts.slice() }
      },
    }
  })
}

export async function startRuntimeClsProbe(page: Page, action: string, targetMessageID?: string) {
  return page.evaluate(
    ({ action, targetMessageID }) => {
      const probe = (window as BrowserRuntimeClsWindow).__pawwork_runtime_cls_probe
      if (!probe) throw new Error("runtime CLS probe is not installed")
      return probe.start(action, targetMessageID)
    },
    { action, targetMessageID },
  ) as Promise<RuntimeClsTargetStyle | undefined>
}

export async function stopRuntimeClsProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (window as BrowserRuntimeClsWindow).__pawwork_runtime_cls_probe
    if (!probe) throw new Error("runtime CLS probe is not installed")
    return probe.stop()
  }) as Promise<RuntimeClsProbeSnapshot>
}
