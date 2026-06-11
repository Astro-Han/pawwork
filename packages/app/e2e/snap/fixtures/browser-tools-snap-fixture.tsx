import { Dynamic, render } from "solid-js/web"
import { Show, type Accessor } from "solid-js"
import type { ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import type { UiI18nKey } from "@opencode-ai/ui/context"
import { DataProvider, I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { ToolRegistry } from "@opencode-ai/ui/message-part"
import { TrowBlock, type TrowPart } from "@opencode-ai/ui/session-turn-trow-block"
import { fixtureData, labels, zhI18n } from "./trow-snap-fixture-data"

const PAGE_URL = "https://example.com/pricing"

const SNAPSHOT_OUTPUT = [
  '- heading "Pricing" [ref=e1]',
  '- link "Get started" [ref=e12]',
  '- textbox "Work email" [ref=e7]',
  '- button "Contact sales" [ref=e9]',
].join("\n")

const EXTRACT_OUTPUT = "# Pricing\n\nSimple plans for every team. Starter is free forever;\nPro adds unlimited projects and priority support."

const BROWSER_TITLE_KEYS: Record<string, UiI18nKey> = {
  browser_navigate: "ui.tool.browser.navigate",
  browser_snapshot: "ui.tool.browser.snapshot",
  browser_click: "ui.tool.browser.click",
  browser_type: "ui.tool.browser.type",
  browser_wait: "ui.tool.browser.wait",
  browser_screenshot: "ui.tool.browser.screenshot",
  browser_extract: "ui.tool.browser.extract",
}

function browserTool(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  output = "",
  metadata: Record<string, unknown> = {},
  status: ToolState["status"] = "completed",
): ToolPart {
  const state: ToolState =
    status === "running"
      ? { status: "running", input, time: { start: 0 } }
      : { status: "completed", input, output, title: toolName, metadata, time: { start: 0, end: 1 } }
  return {
    id,
    sessionID: "snap-session",
    messageID: "snap-message",
    type: "tool",
    callID: `call-${id}`,
    tool: toolName,
    state,
  }
}

const completedBrowserParts = [
  browserTool("browser-navigate", "browser_navigate", { url: PAGE_URL }, "", { url: PAGE_URL }),
  browserTool("browser-snapshot", "browser_snapshot", {}, SNAPSHOT_OUTPUT, { url: PAGE_URL }),
  browserTool("browser-click", "browser_click", { ref: "e12" }, "Clicked e12"),
  browserTool("browser-type", "browser_type", { ref: "e7", text: "team@example.com" }, "Typed into e7"),
  browserTool("browser-wait", "browser_wait", { text: "Thanks for signing up" }, "Condition met"),
  browserTool("browser-screenshot", "browser_screenshot", {}, "Captured viewport", { url: PAGE_URL }),
  browserTool("browser-extract", "browser_extract", { selector: "main" }, EXTRACT_OUTPUT, { url: PAGE_URL }),
]

const runningBrowserParts = [
  browserTool("browser-navigate-running", "browser_navigate", { url: PAGE_URL }, "", {}, "running"),
]

const OPEN_CARDS = ["browser-snapshot", "browser-extract"]

function describeBrowserTool(part: ToolPart) {
  const key = BROWSER_TITLE_KEYS[part.tool]
  return key ? zhI18n.t(key) : part.tool
}

function renderBrowserCard(prefix: string) {
  return (part: Accessor<TrowPart>) => {
    const tool = () => {
      const current = part()
      return current.type === "tool" ? current : undefined
    }
    return (
      <Show when={tool()}>
        {(tool) => {
          const input = () => tool().state.input ?? {}
          const output = () => (tool().state.status === "completed" ? tool().state.output : undefined)
          const metadata = () => (tool().state.status === "completed" ? (tool().state.metadata ?? {}) : {})
          return (
            <div data-slot="trow-result-body" data-card={tool().id} data-timeline-anchor={`tool:${tool().id}`}>
              <Dynamic
                component={ToolRegistry.render(tool().tool)}
                input={input()}
                tool={tool().tool}
                metadata={metadata()}
                output={output()}
                status={tool().state.status}
                defaultOpen={OPEN_CARDS.includes(tool().id)}
                stateKey={`${prefix}:${tool().id}`}
              />
            </div>
          )
        }}
      </Show>
    )
  }
}

function BrowserToolsSnapFixture() {
  return (
    <div
      style={{
        display: "grid",
        gap: "18px",
        padding: "24px",
        background: "var(--bg-base)",
        color: "var(--fg-base)",
        width: "760px",
      }}
    >
      <div data-snap="browser-cards">
        <TrowBlock
          parts={completedBrowserParts}
          defaultOpen
          labels={labels}
          describeTool={describeBrowserTool}
          renderPart={renderBrowserCard("browser-cards")}
        />
      </div>
      <div data-snap="browser-running">
        <TrowBlock
          parts={runningBrowserParts}
          working
          labels={labels}
          describeTool={describeBrowserTool}
          renderPart={renderBrowserCard("browser-running")}
        />
      </div>
      <div data-snap="browser-trow-collapsed">
        <TrowBlock parts={completedBrowserParts} labels={labels} />
      </div>
    </div>
  )
}

export function mountBrowserToolsSnapFixture(root: HTMLElement) {
  root.innerHTML = ""
  render(
    () => (
      <I18nProvider value={zhI18n}>
        <MarkedProvider>
          {/* The real app wraps every surface in DialogProvider (app.tsx); the
              screenshot card's click-to-preview needs it even to render. */}
          <DialogProvider>
            <DataProvider data={fixtureData} directory="/Users/yuhan/PawWork">
              <BrowserToolsSnapFixture />
            </DataProvider>
          </DialogProvider>
        </MarkedProvider>
      </I18nProvider>
    ),
    root,
  )
}
