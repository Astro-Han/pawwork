import { createEffect, createMemo, Show, type Accessor, type JSXElement } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Toast } from "@opencode-ai/ui/toast"
import { isMacShell, shellAttrs, type usePlatform } from "@/context/platform"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar } from "@/components/titlebar"
import { PawworkTitlebar } from "./pawwork-titlebar"
import { shouldShowLayoutDebugBar } from "./layout-shell-frame-debug"

type LayoutShellFrameProps = {
  platform: ReturnType<typeof usePlatform>
  sizing: Accessor<boolean>
  sidebar: {
    visible: Accessor<boolean>
    width: Accessor<number>
    minWidth: number
    maxWidth: Accessor<number>
    label: Accessor<string>
    content: () => JSXElement
    onResizeStart: () => void
    onResize: (width: number) => void
  }
  rightPanel: {
    opened: Accessor<boolean>
    width: Accessor<number>
  }
  settings: {
    open: Accessor<boolean>
    title: Accessor<string>
    nav: () => JSXElement
    content: () => JSXElement
  }
  main: () => JSXElement
}

export function LayoutShellFrame(props: LayoutShellFrameProps) {
  const side = createMemo(() => Math.max(props.sidebar.width(), props.sidebar.minWidth))

  createEffect(() => {
    const sidebarWidth = props.sidebar.visible() ? props.sidebar.width() : 0
    document.documentElement.style.setProperty("--dialog-left-margin", `${sidebarWidth}px`)
  })

  return (
    <div
      data-component="desktop-shell"
      data-platform={props.platform.platform}
      {...shellAttrs(props.platform)}
      class="relative bg-bg-base flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      classList={{
        "[transition:--sidebar-width_200ms_cubic-bezier(0.22,1,0.36,1),--right-panel-width_240ms_cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none":
          !props.sizing(),
      }}
      style={{
        "--shell-titlebar-current-height": isMacShell(props.platform)
          ? `calc(var(--shell-titlebar-height, 44px) / ${props.platform.webviewZoom?.() ?? 1})`
          : "var(--shell-titlebar-height, 44px)",
        "--sidebar-width": props.sidebar.visible() ? `${side()}px` : "0px",
        "--right-panel-width": props.rightPanel.opened() ? `${props.rightPanel.width()}px` : "0px",
        "--right-panel-divider": props.rightPanel.opened() ? "var(--border-weaker)" : "transparent",
      }}
    >
      <div
        data-component="desktop-shell-frame"
        data-platform={props.platform.platform}
        {...shellAttrs(props.platform)}
        class="flex flex-1 min-h-0 min-w-0 flex-col"
      >
        <Titlebar />
        <PawworkTitlebar visible={props.settings.open} title={props.settings.title} />
        <div class="flex-1 min-h-0 min-w-0 flex">
          <div class="flex-1 min-h-0 relative">
            <div data-component="shell-content" class="size-full relative overflow-x-hidden">
              <Show when={props.sidebar.visible()}>
                <aside
                  aria-label={props.sidebar.label()}
                  data-component="sidebar-nav-desktop"
                  class="absolute inset-y-0 left-0 z-10 border-r border-border-weaker"
                  style={{ width: `${side()}px` }}
                >
                  <div
                    classList={{ "@container w-full h-full contain-strict": true, invisible: props.settings.open() }}
                    inert={props.settings.open() ? true : undefined}
                    aria-hidden={props.settings.open() || undefined}
                  >
                    {props.sidebar.content()}
                  </div>
                  {/* Settings takeover keeps the session sidebar mounted so its scroll state survives. */}
                  <Show when={props.settings.open()}>
                    <div class="absolute inset-0 z-10">{props.settings.nav()}</div>
                  </Show>
                </aside>

                <Show when={!props.settings.open()}>
                  <div
                    class="absolute inset-y-0 z-30 w-0 overflow-visible"
                    style={{ left: `${side()}px` }}
                    onPointerDown={props.sidebar.onResizeStart}
                  >
                    <ResizeHandle
                      direction="horizontal"
                      size={props.sidebar.width()}
                      min={props.sidebar.minWidth}
                      max={props.sidebar.maxWidth()}
                      onResize={props.sidebar.onResize}
                    />
                  </div>
                </Show>
              </Show>

              <div
                classList={{
                  "absolute inset-y-0 right-0 left-[var(--main-left)]": true,
                  "z-20": true,
                  "transition-[left] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[left] motion-reduce:transition-none":
                    !props.sizing(),
                }}
                style={{
                  "--main-left": props.sidebar.visible() ? `${side()}px` : "0",
                }}
              >
                <main
                  data-component="desktop-shell-main"
                  data-platform={props.platform.platform}
                  {...shellAttrs(props.platform)}
                  classList={{
                    "size-full overflow-x-hidden flex flex-col items-start contain-strict": true,
                  }}
                >
                  <div class="relative size-full">
                    <div
                      inert={props.settings.open() ? true : undefined}
                      aria-hidden={props.settings.open() || undefined}
                      classList={{ "size-full": true, invisible: props.settings.open() }}
                    >
                      {props.main()}
                    </div>
                    {/* Settings takeover keeps the session page mounted so terminal and panel state survive. */}
                    <Show when={props.settings.open()}>
                      <div class="absolute inset-0 z-10">{props.settings.content()}</div>
                    </Show>
                  </div>
                </main>
              </div>
            </div>
          </div>
          {shouldShowLayoutDebugBar() && <DebugBar />}
        </div>
      </div>
      <Toast.Region />
    </div>
  )
}
