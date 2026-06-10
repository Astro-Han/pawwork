import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { BrowserBridge, BrowserState, BrowserViewRect } from "@/context/platform"
import { formatAddress, normalizeAddressInput } from "./url"
import { rectsEqual, shouldShowBrowserView } from "./view-state"

const HIDDEN_RECT: BrowserViewRect = { x: 0, y: 0, width: 0, height: 0 }

/**
 * The embedded browser tab body: navigation toolbar, editable address bar,
 * overflow menu, and the content region the native WebContentsView is painted
 * over. The page itself lives in the main process (it survives tab switches);
 * this component owns the DOM chrome and reports the content rect so main can
 * size/show the overlay.
 */
export function BrowserPanel(props: {
  bridge: BrowserBridge
  active: () => boolean
  panelOpen: () => boolean
  // True while a right-panel chrome menu (the titlebar add-tab "+" menu) is open.
  // It lives in a sibling component but its dropdown overlaps this content rect.
  panelChromeMenuOpen: () => boolean
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const platform = usePlatform()
  const bridge = props.bridge

  const [state, setState] = createSignal<BrowserState | null>(null)
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [rect, setRect] = createSignal<BrowserViewRect | null>(null)

  let host: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined

  // Subscribe first, then seed once — and only if no push has arrived yet, so a
  // navigation landing mid-flight isn't clobbered by the older getState snapshot.
  onCleanup(bridge.onState(setState))
  onMount(() => {
    void bridge.getState().then((s) => s && setState((prev) => prev ?? s))
  })

  const url = () => state()?.url ?? ""
  const hasPage = () => state()?.hasPage ?? false
  const loading = () => state()?.loading ?? false
  const secure = () => state()?.secure ?? false
  const address = createMemo(() => formatAddress(url()))

  // Hide the native overlay whenever something must paint above it: an app modal,
  // this tab's own overflow menu, or a right-panel chrome menu (the titlebar
  // add-tab "+" menu opens downward over this content region). The view is a
  // native layer, so DOM stacking can't lift those above it — it must be hidden.
  const suppressed = () => !!dialog.active || menuOpen() || props.panelChromeMenuOpen()
  const shouldShow = createMemo(() =>
    shouldShowBrowserView({
      panelOpen: props.panelOpen(),
      active: props.active(),
      hasPage: hasPage(),
      suppressed: suppressed(),
    }),
  )

  // Push visibility + bounds to main as one unit so they never race.
  createEffect(() => {
    if (!shouldShow()) {
      void bridge.setView({ visible: false, rect: HIDDEN_RECT })
      return
    }
    const r = rect()
    if (r) void bridge.setView({ visible: true, rect: r })
  })

  // While visible, track the content rect every frame: a native overlay must
  // follow position changes (window resize moving the right-aligned panel, the
  // open/close slide, drag-resize) that a ResizeObserver can't observe. The
  // diff keeps this from sending IPC unless the device-pixel rect actually moved.
  createEffect(() => {
    if (!shouldShow()) return
    let raf = 0
    const measure = () => {
      if (host) {
        const b = host.getBoundingClientRect()
        const next = { x: b.x, y: b.y, width: b.width, height: b.height }
        setRect((prev) => (rectsEqual(prev, next) ? prev : next))
      }
      raf = requestAnimationFrame(measure)
    }
    raf = requestAnimationFrame(measure)
    onCleanup(() => cancelAnimationFrame(raf))
  })

  onCleanup(() => void bridge.setView({ visible: false, rect: HIDDEN_RECT }))

  const beginEdit = () => {
    setDraft(url())
    setEditing(true)
    requestAnimationFrame(() => {
      input?.focus()
      input?.select()
    })
  }

  const submit = () => {
    const target = normalizeAddressInput(draft())
    setEditing(false)
    if (target) void bridge.navigate(target)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault()
      submit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      setEditing(false)
      input?.blur()
    }
  }

  const confirmClearData = () => {
    dialog.show(() => (
      <Dialog
        title={language.t("browser.clearData.title")}
        description={language.t("browser.clearData.description")}
        footer={
          <>
            <Button variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                dialog.close()
                void bridge.clearData()
              }}
            >
              {language.t("browser.clearData.confirm")}
            </Button>
          </>
        }
      />
    ))
  }

  return (
    <div class="flex flex-col h-full min-h-0">
      {/* Navigation toolbar */}
      <div class="relative flex items-center gap-1 h-11 shrink-0 px-2 border-b border-border-weaker">
        <IconButton
          icon="arrow-left"
          variant="ghost"
          aria-label={language.t("browser.action.back")}
          disabled={!state()?.canGoBack}
          onClick={() => bridge.goBack()}
        />
        <IconButton
          icon="arrow-right"
          variant="ghost"
          aria-label={language.t("browser.action.forward")}
          disabled={!state()?.canGoForward}
          onClick={() => bridge.goForward()}
        />
        <Show
          when={loading()}
          fallback={
            <IconButton
              icon="refresh"
              variant="ghost"
              aria-label={language.t("browser.action.reload")}
              disabled={!hasPage()}
              onClick={() => bridge.reload()}
            />
          }
        >
          <IconButton
            icon="close"
            variant="ghost"
            aria-label={language.t("browser.action.stop")}
            onClick={() => bridge.stop()}
          />
        </Show>

        {/* Address bar: two-tone display, swapped for an input while editing */}
        <Show
          when={editing()}
          fallback={
            <button
              type="button"
              class="flex-1 min-w-0 flex items-center gap-1.5 h-7 px-3 rounded-full bg-bg-cream border border-border-weaker text-left cursor-text"
              onClick={beginEdit}
            >
              <Show when={secure()}>
                <Icon name="lock" class="text-fg-weaker shrink-0" />
              </Show>
              <Show
                when={hasPage()}
                fallback={<span class="truncate text-fg-weaker">{language.t("browser.address.placeholder")}</span>}
              >
                <span class="truncate">
                  <span class="text-fg-strong">{address().host}</span>
                  <span class="text-fg-weak">{address().path}</span>
                </span>
              </Show>
            </button>
          }
        >
          <input
            ref={input}
            value={draft()}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            placeholder={language.t("browser.address.placeholder")}
            class="flex-1 min-w-0 h-7 px-3 rounded-full bg-bg-base border border-brand outline-none ring-2 ring-brand/25 text-fg-strong"
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            onBlur={() => setEditing(false)}
          />
        </Show>

        <DropdownMenu gutter={4} placement="bottom-end" onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger
            as={IconButton}
            icon="dot-grid"
            variant="ghost"
            class="shrink-0"
            aria-label={language.t("browser.action.more")}
          />
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <DropdownMenu.Item disabled={!hasPage()} onSelect={() => platform.openLink(url())}>
                <Icon name="square-arrow-top-right" />
                <DropdownMenu.ItemLabel>{language.t("browser.action.openExternal")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={!hasPage()} onSelect={() => void navigator.clipboard?.writeText(url())}>
                <Icon name="copy" />
                <DropdownMenu.ItemLabel>{language.t("browser.action.copyLink")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item class="text-error" onSelect={confirmClearData}>
                <Icon name="trash" />
                <DropdownMenu.ItemLabel>{language.t("browser.action.clearData")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>

        <Show when={loading()}>
          <div class="absolute inset-x-0 -bottom-px h-0.5 bg-brand/80 animate-pulse" />
        </Show>
      </div>

      {/* Content region: the native WebContentsView is painted over this rect.
          When there is no page, the view stays hidden and the empty state shows. */}
      <div ref={host} data-component="browser-content" class="relative flex-1 min-h-0 overflow-hidden bg-bg-base">
        <Show when={!hasPage()}>
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-8 text-center text-fg-weak">
            <div class="text-fg-strong">{language.t("browser.empty.title")}</div>
            <div class="max-w-xs">{language.t("browser.empty.description")}</div>
          </div>
        </Show>
      </div>
    </div>
  )
}
