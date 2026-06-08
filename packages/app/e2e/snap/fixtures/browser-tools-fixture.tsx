import { For } from "solid-js"
import { Dynamic, render } from "solid-js/web"
import { I18nProvider } from "@opencode-ai/ui/context"
import { ToolRegistry } from "@opencode-ai/ui/message-part"
import { zhI18n } from "./trow-snap-fixture-data"

// One representative call per embedded-browser tool, so the snap shows each
// card's icon, title, and subtitle exactly as the timeline renders them.
const CARDS: Array<{ tool: string; input: Record<string, unknown> }> = [
  { tool: "browser_navigate", input: { url: "https://news.ycombinator.com/" } },
  { tool: "browser_screenshot", input: {} },
  { tool: "browser_extract", input: { selector: "main article" } },
  { tool: "browser_wait", input: { selector: ".results" } },
  { tool: "browser_click", input: { selector: "button[type=submit]" } },
  { tool: "browser_type", input: { selector: "input[name=q]", text: "pawwork" } },
]

function BrowserToolsFixture() {
  return (
    <div
      data-snap="browser-tool-cards"
      style={{
        display: "grid",
        gap: "8px",
        padding: "24px",
        background: "var(--bg-base)",
        color: "var(--fg-base)",
        width: "440px",
      }}
    >
      <For each={CARDS}>
        {(card) => {
          const component = ToolRegistry.render(card.tool)
          return (
            <div data-slot="trow-result-body" data-timeline-anchor={`tool:${card.tool}`}>
              <Dynamic component={component} tool={card.tool} input={card.input} metadata={{}} status="completed" />
            </div>
          )
        }}
      </For>
    </div>
  )
}

export function mountBrowserToolsFixture(root: HTMLElement) {
  root.innerHTML = ""
  render(
    () => (
      <I18nProvider value={zhI18n}>
        <BrowserToolsFixture />
      </I18nProvider>
    ),
    root,
  )
}
