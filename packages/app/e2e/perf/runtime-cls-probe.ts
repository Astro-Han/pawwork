import type { Page } from "@playwright/test"

export type RuntimeClsRect = {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

export type RuntimeClsScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  maxScrollTop: number
}

export type RuntimeClsTransactionSnapshot = {
  activeBefore?: boolean
  activeAfter?: boolean
  idBefore?: string
  idAfter?: string
  kindBefore?: string
  kindAfter?: string
}

export type RuntimeClsSourceKind =
  | "primary-message-wrapper"
  | "primary-turn"
  | "primary-turn-descendant"
  | "residual-assistant-message"
  | "dock-or-scroll-recovery"
  | "other"

export type RuntimeClsSourceNode = {
  label: string
  rect?: RuntimeClsRect
  path: string[]
}

export type RuntimeClsPrimaryAncestor = {
  label: string
  beforeRect?: RuntimeClsRect
  afterRect?: RuntimeClsRect
  visibleBefore: boolean
  visibleAfter: boolean
}

export type RuntimeClsSourceClassification = {
  kind: RuntimeClsSourceKind
  source: RuntimeClsSourceNode
  primaryAncestor?: RuntimeClsPrimaryAncestor
}

export type RuntimeClsEntry = {
  at: number
  value: number
  hadRecentInput: boolean
  sources: RuntimeClsSourceClassification[]
}

export type RuntimeClsSnapshot = {
  targetMessageID?: string
  targetBeforeRect?: RuntimeClsRect
  targetAfterRect?: RuntimeClsRect
  renderMode?: string
  totalRows?: number
  mountedRows?: number
  scrollBefore?: RuntimeClsScrollMetrics
  scrollAfter?: RuntimeClsScrollMetrics
  transaction?: RuntimeClsTransactionSnapshot
}

export type RuntimeClsResult = {
  action: string
  startedAt: number
  endedAt: number
  entries: RuntimeClsEntry[]
  snapshot: RuntimeClsSnapshot
}

type RuntimeClsStartOptions = {
  targetMessageID?: string
}

type RuntimeClsWindow = Window & {
  __pawwork_runtime_cls_probe?: {
    start: (action: string, options?: RuntimeClsStartOptions) => void
    stop: () => RuntimeClsResult
  }
}

type RuntimeClsProbeInstallOptions = {
  mockObserver?: "ready" | "observe-error"
}

type PrimaryBeforeRectStore = Pick<Map<Element, RuntimeClsRect>, "get">

const primarySelector = '[data-message-id], [data-component="session-turn"]'
const assistantResidualSelector =
  '[data-component="assistant-message"], [data-slot="session-turn-assistant-content"], [data-component="markdown"], [data-component="message-part"]'
const dockOrScrollSelector =
  '[data-component="dock-prompt"], [data-component="session-prompt-dock"], [data-slot="question-options"], [data-slot="question-option"], [data-component="scroll-jump"], [data-action="scroll-to-bottom"]'

// Absolute single-entry threshold for a large primary timeline shift. This is
// intentionally not the Web Vitals cumulative CLS threshold: the runtime gate
// fails only when one measured action produces a >0.02 LayoutShift entry whose
// source belongs to visible timeline content.
export const RUNTIME_CLS_PRIMARY_SHIFT_THRESHOLD = 0.02

const primaryFailureKinds = new Set<RuntimeClsSourceKind>([
  "primary-message-wrapper",
  "primary-turn",
  "primary-turn-descendant",
])

export function isRuntimeClsPrimarySource(source: RuntimeClsSourceClassification) {
  return primaryFailureKinds.has(source.kind)
}

export function isRuntimeClsPrimaryEntry(entry: RuntimeClsEntry) {
  return entry.sources.some(isRuntimeClsPrimarySource)
}

export function rectFromDomRect(input: DOMRect | RuntimeClsRect): RuntimeClsRect {
  return {
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    top: input.top,
    right: input.right,
    bottom: input.bottom,
    left: input.left,
  }
}

function isVisibleRect(rect: RuntimeClsRect | undefined, viewportHeight: number, viewportWidth: number) {
  if (!rect) return false
  return rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth
}

function stableElementLabel(element: Element) {
  const messageID = element.getAttribute("data-message-id")
  if (messageID) return `[data-message-id="${messageID}"]`

  const dataMessage = element.getAttribute("data-message")
  if (dataMessage) return `[data-message="${dataMessage}"]`

  const component = element.getAttribute("data-component")
  if (component) return `[data-component="${component}"]`

  const slot = element.getAttribute("data-slot")
  if (slot) return `[data-slot="${slot}"]`

  if (element.id) return `#${element.id}`

  const tag = element.tagName.toLowerCase()
  const classes = Array.from(element.classList).slice(0, 3)
  return classes.length > 0 ? `${tag}.${classes.join(".")}` : tag
}

function elementPath(element: Element) {
  const path: string[] = []
  let current: Element | null = element
  while (current && path.length < 8) {
    path.push(stableElementLabel(current))
    current = current.parentElement
  }
  return path
}

function findPrimaryAncestor(source: Element) {
  return source.closest(primarySelector)
}

function findPrimaryBeforeRect(primary: Element, store: PrimaryBeforeRectStore) {
  const direct = store.get(primary)
  if (direct) return direct

  const message = primary.closest("[data-message-id]")
  if (message) {
    const messageRect = store.get(message)
    if (messageRect) return messageRect
  }

  const turn = primary.closest('[data-component="session-turn"]')
  if (turn) return store.get(turn)
}

function sourceNodeSnapshot(source: Element): RuntimeClsSourceNode {
  return {
    label: stableElementLabel(source),
    rect: rectFromDomRect(source.getBoundingClientRect()),
    path: elementPath(source),
  }
}

function primaryAncestorSnapshot(input: {
  source: Element
  primary: Element | null
  viewportHeight: number
  viewportWidth: number
  primaryBeforeRects: PrimaryBeforeRectStore
}): RuntimeClsPrimaryAncestor | undefined {
  if (!input.primary) return undefined
  const beforeRect = findPrimaryBeforeRect(input.primary, input.primaryBeforeRects)
  const afterRect = rectFromDomRect(input.primary.getBoundingClientRect())
  return {
    label: stableElementLabel(input.primary),
    beforeRect,
    afterRect,
    visibleBefore: isVisibleRect(beforeRect, input.viewportHeight, input.viewportWidth),
    visibleAfter: isVisibleRect(afterRect, input.viewportHeight, input.viewportWidth),
  }
}

export function classifyRuntimeClsSource(
  source: Element | null,
  input: {
    viewportHeight: number
    viewportWidth?: number
    primaryBeforeRects: PrimaryBeforeRectStore
  },
): RuntimeClsSourceClassification {
  if (!source) {
    return { kind: "other", source: { label: "<missing-source>", path: [] } }
  }

  const viewportWidth = input.viewportWidth ?? 1024
  const primary = findPrimaryAncestor(source)
  const ancestor = primaryAncestorSnapshot({
    source,
    primary,
    viewportHeight: input.viewportHeight,
    viewportWidth,
    primaryBeforeRects: input.primaryBeforeRects,
  })
  const sourceSnapshot = sourceNodeSnapshot(source)
  const primaryVisible = ancestor?.visibleBefore === true && ancestor.visibleAfter === true

  if (source.matches("[data-message-id]") && primaryVisible) {
    return { kind: "primary-message-wrapper", source: sourceSnapshot, primaryAncestor: ancestor }
  }

  if (source.matches('[data-component="session-turn"]') && primaryVisible) {
    return { kind: "primary-turn", source: sourceSnapshot, primaryAncestor: ancestor }
  }

  if (source.closest(dockOrScrollSelector)) {
    return { kind: "dock-or-scroll-recovery", source: sourceSnapshot, primaryAncestor: ancestor }
  }

  if (primary && primaryVisible) {
    return { kind: "primary-turn-descendant", source: sourceSnapshot, primaryAncestor: ancestor }
  }

  if (source.closest(assistantResidualSelector)) {
    return { kind: "residual-assistant-message", source: sourceSnapshot, primaryAncestor: ancestor }
  }

  return { kind: "other", source: sourceSnapshot, primaryAncestor: ancestor }
}

export function collectRuntimeClsFailures(entries: RuntimeClsEntry[], threshold = RUNTIME_CLS_PRIMARY_SHIFT_THRESHOLD) {
  return entries.filter((entry) => entry.value > threshold && isRuntimeClsPrimaryEntry(entry))
}

export function formatRuntimeClsFailure(input: {
  action: string
  entries: RuntimeClsEntry[]
  snapshot: RuntimeClsSnapshot
}) {
  const primaryEntries = input.entries.map((entry) => ({
    at: entry.at,
    value: entry.value,
    hadRecentInput: entry.hadRecentInput,
    sources: entry.sources.map((source) => ({
      kind: source.kind,
      label: source.source.label,
      path: source.source.path,
      sourceRect: source.source.rect,
      primaryAncestor: source.primaryAncestor,
    })),
  }))
  const maxValue = Math.max(0, ...input.entries.map((entry) => entry.value))
  const transactionSummary = input.snapshot.transaction
    ? [
        `transaction=${input.snapshot.transaction.idBefore ?? input.snapshot.transaction.idAfter ?? "<none>"}`,
        `transactionKind=${input.snapshot.transaction.kindBefore ?? input.snapshot.transaction.kindAfter ?? "<none>"}`,
        `transactionActiveBefore=${input.snapshot.transaction.activeBefore ?? false}`,
        `transactionActiveAfter=${input.snapshot.transaction.activeAfter ?? false}`,
      ].join(" ")
    : "transaction=<none>"
  const sourceSummary = input.entries
    .flatMap((entry) =>
      entry.sources.map((source) =>
        [
          `entry=${entry.value}`,
          `hadRecentInput=${entry.hadRecentInput}`,
          `kind=${source.kind}`,
          `source=${source.source.label}`,
          `primary=${source.primaryAncestor?.label ?? "<none>"}`,
        ].join(" "),
      ),
    )
    .join("\n")
  return [
    `Runtime CLS primary source gate failed during ${input.action}.`,
    `Threshold: single entry > ${RUNTIME_CLS_PRIMARY_SHIFT_THRESHOLD}; max primary entry: ${maxValue}.`,
    transactionSummary,
    sourceSummary,
    JSON.stringify(
      {
        action: input.action,
        entries: primaryEntries,
        snapshot: input.snapshot,
      },
      null,
      2,
    ),
  ].join("\n")
}

function runtimeClsProbeInitScript(options?: RuntimeClsProbeInstallOptions) {
  type RuntimeClsRect = {
    x: number
    y: number
    width: number
    height: number
    top: number
    right: number
    bottom: number
    left: number
  }

  type RuntimeClsSourceKind =
    | "primary-message-wrapper"
    | "primary-turn"
    | "primary-turn-descendant"
    | "residual-assistant-message"
    | "dock-or-scroll-recovery"
    | "other"

  type RuntimeClsSourceClassification = {
    kind: RuntimeClsSourceKind
    source: { label: string; rect?: RuntimeClsRect; path: string[] }
    primaryAncestor?: {
      label: string
      beforeRect?: RuntimeClsRect
      afterRect?: RuntimeClsRect
      visibleBefore: boolean
      visibleAfter: boolean
    }
  }

  type RuntimeClsEntry = {
    at: number
    value: number
    hadRecentInput: boolean
    sources: RuntimeClsSourceClassification[]
  }

  type RuntimeClsScrollMetrics = {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    maxScrollTop: number
  }

  type RuntimeClsTransactionSnapshot = {
    activeBefore?: boolean
    activeAfter?: boolean
    idBefore?: string
    idAfter?: string
    kindBefore?: string
    kindAfter?: string
  }

  type RuntimeClsSnapshot = {
    targetMessageID?: string
    targetBeforeRect?: RuntimeClsRect
    targetAfterRect?: RuntimeClsRect
    renderMode?: string
    totalRows?: number
    mountedRows?: number
    scrollBefore?: RuntimeClsScrollMetrics
    scrollAfter?: RuntimeClsScrollMetrics
    transaction?: RuntimeClsTransactionSnapshot
  }

  type RuntimeClsWindow = Window & {
    __pawwork_runtime_cls_probe?: {
      start: (action: string, options?: { targetMessageID?: string }) => void
      stop: () => {
        action: string
        startedAt: number
        endedAt: number
        entries: RuntimeClsEntry[]
        snapshot: RuntimeClsSnapshot
      }
    }
    __emitRuntimeClsEntry?: (
      entry: PerformanceEntry & {
        value?: number
        hadRecentInput?: boolean
        sources?: Array<{ node?: Node | null }>
      },
    ) => void
  }

  const win = window as RuntimeClsWindow
  if (win.__pawwork_runtime_cls_probe) return

  if (options?.mockObserver) {
    type MockEntry = PerformanceEntry & {
      value?: number
      hadRecentInput?: boolean
      sources?: Array<{ node?: Node | null }>
    }

    const callbacks: Array<(entries: MockEntry[]) => void> = []
    class MockPerformanceObserver {
      private readonly callback: PerformanceObserverCallback

      constructor(callback: PerformanceObserverCallback) {
        this.callback = callback
        callbacks.push((entries) => {
          this.callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as PerformanceObserver)
        })
      }

      observe() {
        if (options.mockObserver === "observe-error") throw new Error("mock layout-shift unsupported")
      }

      disconnect() {}
      takeRecords() {
        return []
      }

      static supportedEntryTypes = ["layout-shift"]
    }

    ;(window as typeof window & { PerformanceObserver: typeof PerformanceObserver }).PerformanceObserver =
      MockPerformanceObserver as typeof PerformanceObserver
    win.__emitRuntimeClsEntry = (entry) => {
      for (const callback of callbacks) callback([entry])
    }
  }

  const primarySelector = '[data-message-id], [data-component="session-turn"]'
  const assistantResidualSelector =
    '[data-component="assistant-message"], [data-slot="session-turn-assistant-content"], [data-component="markdown"], [data-component="message-part"]'
  const dockOrScrollSelector =
    '[data-component="dock-prompt"], [data-component="session-prompt-dock"], [data-slot="question-options"], [data-slot="question-option"], [data-component="scroll-jump"], [data-action="scroll-to-bottom"]'

  const maxEntries = 256
  let action = "unknown"
  let startedAt = 0
  let active = false
  let entries: RuntimeClsEntry[] = []
  let primaryBeforeRects = new WeakMap<Element, RuntimeClsRect>()
  let snapshotBefore: RuntimeClsSnapshot = {}
  let observerReady = false
  let observerError: string | undefined

  const rectFromDomRect = (input: DOMRect): RuntimeClsRect => ({
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    top: input.top,
    right: input.right,
    bottom: input.bottom,
    left: input.left,
  })

  const isVisibleRect = (rect: RuntimeClsRect | undefined) => {
    if (!rect) return false
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
  }

  const stableElementLabel = (element: Element) => {
    const messageID = element.getAttribute("data-message-id")
    if (messageID) return `[data-message-id="${messageID}"]`
    const dataMessage = element.getAttribute("data-message")
    if (dataMessage) return `[data-message="${dataMessage}"]`
    const component = element.getAttribute("data-component")
    if (component) return `[data-component="${component}"]`
    const slot = element.getAttribute("data-slot")
    if (slot) return `[data-slot="${slot}"]`
    if (element.id) return `#${element.id}`
    const tag = element.tagName.toLowerCase()
    const classes = Array.from(element.classList).slice(0, 3)
    return classes.length > 0 ? `${tag}.${classes.join(".")}` : tag
  }

  const elementPath = (element: Element) => {
    const path: string[] = []
    let current: Element | null = element
    while (current && path.length < 8) {
      path.push(stableElementLabel(current))
      current = current.parentElement
    }
    return path
  }

  const sourceSnapshot = (source: Element) => ({
    label: stableElementLabel(source),
    rect: rectFromDomRect(source.getBoundingClientRect()),
    path: elementPath(source),
  })

  const findPrimaryBeforeRect = (primary: Element) => {
    const direct = primaryBeforeRects.get(primary)
    if (direct) return direct
    const message = primary.closest("[data-message-id]")
    if (message) {
      const messageRect = primaryBeforeRects.get(message)
      if (messageRect) return messageRect
    }
    const turn = primary.closest('[data-component="session-turn"]')
    if (turn) return primaryBeforeRects.get(turn)
  }

  const classifyElement = (element: Element | null): RuntimeClsSourceClassification => {
    if (!element) return { kind: "other", source: { label: "<missing-source>", path: [] } }
    const primary = element.closest(primarySelector)
    const primaryAncestor = primary
      ? {
          label: stableElementLabel(primary),
          beforeRect: findPrimaryBeforeRect(primary),
          afterRect: rectFromDomRect(primary.getBoundingClientRect()),
          visibleBefore: false,
          visibleAfter: false,
        }
      : undefined
    if (primaryAncestor) {
      primaryAncestor.visibleBefore = isVisibleRect(primaryAncestor.beforeRect)
      primaryAncestor.visibleAfter = isVisibleRect(primaryAncestor.afterRect)
    }
    const source = sourceSnapshot(element)
    const primaryVisible = primaryAncestor?.visibleBefore === true && primaryAncestor.visibleAfter === true

    if (element.matches("[data-message-id]") && primaryVisible) {
      return { kind: "primary-message-wrapper", source, primaryAncestor }
    }
    if (element.matches('[data-component="session-turn"]') && primaryVisible) {
      return { kind: "primary-turn", source, primaryAncestor }
    }
    if (element.closest(dockOrScrollSelector)) return { kind: "dock-or-scroll-recovery", source, primaryAncestor }
    if (primary && primaryVisible) {
      return { kind: "primary-turn-descendant", source, primaryAncestor }
    }
    if (element.closest(assistantResidualSelector))
      return { kind: "residual-assistant-message", source, primaryAncestor }
    return { kind: "other", source, primaryAncestor }
  }

  const readScrollMetrics = (): RuntimeClsScrollMetrics | undefined => {
    const list = document.querySelector('[data-slot="session-turn-list"]')
    const viewport = list?.closest('[data-component="scroll-viewport"]')
    if (!(viewport instanceof HTMLElement)) return undefined
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    return {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      maxScrollTop,
    }
  }

  const messageByID = (id: string | undefined) => {
    if (!id) return undefined
    return Array.from(document.querySelectorAll("[data-message-id]")).find(
      (node) => node.getAttribute("data-message-id") === id,
    )
  }

  const readSnapshot = (targetMessageID?: string): RuntimeClsSnapshot => {
    const list = document.querySelector('[data-slot="session-turn-list"]') as HTMLElement | null
    const virtualRows = document.querySelectorAll('[data-component="session-virtual-row"]').length
    const messages = document.querySelectorAll("[data-message-id]").length
    const target = messageByID(targetMessageID)
    return {
      targetMessageID,
      targetAfterRect: target instanceof Element ? rectFromDomRect(target.getBoundingClientRect()) : undefined,
      renderMode: list?.dataset.renderMode,
      totalRows: list?.dataset.totalRows ? Number(list.dataset.totalRows) : undefined,
      mountedRows: virtualRows > 0 ? virtualRows : messages,
      scrollAfter: readScrollMetrics(),
      transaction: {
        activeAfter: list?.dataset.layoutTransactionActive === "true",
        idAfter: list?.dataset.layoutTransactionId || undefined,
        kindAfter: list?.dataset.layoutTransactionKind || undefined,
      },
    }
  }

  const capturePrimaryBeforeRects = () => {
    primaryBeforeRects = new WeakMap<Element, RuntimeClsRect>()
    for (const element of document.querySelectorAll(primarySelector)) {
      primaryBeforeRects.set(element, rectFromDomRect(element.getBoundingClientRect()))
    }
  }

  if (typeof PerformanceObserver === "undefined") {
    observerError = "PerformanceObserver is unavailable; runtime CLS gate cannot observe layout-shift entries."
  } else if (
    Array.isArray(PerformanceObserver.supportedEntryTypes) &&
    !PerformanceObserver.supportedEntryTypes.includes("layout-shift")
  ) {
    observerError = "PerformanceObserver does not support layout-shift entries; runtime CLS gate cannot run."
  } else {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<
          PerformanceEntry & {
            value?: number
            hadRecentInput?: boolean
            sources?: Array<{ node?: Node | null }>
          }
        >) {
          if (!active || startedAt <= 0 || entry.startTime < startedAt) continue
          if (typeof entry.value !== "number") continue
          const sources = (entry.sources ?? []).map((source) =>
            classifyElement(source.node instanceof Element ? source.node : null),
          )
          entries.push({
            at: entry.startTime,
            value: entry.value,
            hadRecentInput: entry.hadRecentInput === true,
            sources,
          })
        }
        if (entries.length > maxEntries) entries = entries.slice(entries.length - maxEntries)
      })
      observer.observe({ type: "layout-shift", buffered: true })
      observerReady = true
    } catch (error) {
      observerError = error instanceof Error ? error.message : String(error)
    }
  }

  win.__pawwork_runtime_cls_probe = {
    start(nextAction, options) {
      if (!observerReady) {
        throw new Error(observerError ?? "Runtime CLS layout-shift observer did not start.")
      }
      action = nextAction
      entries = []
      startedAt = performance.now()
      active = true
      capturePrimaryBeforeRects()
      const before = readSnapshot(options?.targetMessageID)
      snapshotBefore = {
        targetMessageID: options?.targetMessageID,
        targetBeforeRect: before.targetAfterRect,
        renderMode: before.renderMode,
        totalRows: before.totalRows,
        mountedRows: before.mountedRows,
        scrollBefore: before.scrollAfter,
        transaction: {
          activeBefore: before.transaction?.activeAfter,
          idBefore: before.transaction?.idAfter,
          kindBefore: before.transaction?.kindAfter,
        },
      }
    },
    stop() {
      const after = readSnapshot(snapshotBefore.targetMessageID)
      const result = {
        action,
        startedAt,
        endedAt: performance.now(),
        entries: entries.slice(),
        snapshot: {
          ...snapshotBefore,
          targetAfterRect: after.targetAfterRect,
          renderMode: after.renderMode ?? snapshotBefore.renderMode,
          totalRows: after.totalRows ?? snapshotBefore.totalRows,
          mountedRows: after.mountedRows ?? snapshotBefore.mountedRows,
          scrollAfter: after.scrollAfter,
          transaction: {
            ...snapshotBefore.transaction,
            activeAfter: after.transaction?.activeAfter,
            idAfter: after.transaction?.idAfter,
            kindAfter: after.transaction?.kindAfter,
          },
        },
      }
      active = false
      startedAt = 0
      entries = []
      primaryBeforeRects = new WeakMap<Element, RuntimeClsRect>()
      return result
    },
  }
}

export async function installRuntimeClsProbe(page: Page, options?: RuntimeClsProbeInstallOptions) {
  await page.addInitScript(runtimeClsProbeInitScript, options)
  await page.evaluate(runtimeClsProbeInitScript, options)
}

export async function startRuntimeClsProbe(page: Page, action: string, options?: RuntimeClsStartOptions) {
  await page.evaluate(
    ({ action, options }) => {
      const probe = (window as RuntimeClsWindow).__pawwork_runtime_cls_probe
      if (!probe) throw new Error("Runtime CLS probe is not installed")
      probe.start(action, options)
    },
    { action, options },
  )
}

export async function stopRuntimeClsProbe(page: Page): Promise<RuntimeClsResult> {
  return await page.evaluate(() => {
    const probe = (window as RuntimeClsWindow).__pawwork_runtime_cls_probe
    if (!probe) throw new Error("Runtime CLS probe is not installed")
    return probe.stop()
  })
}
