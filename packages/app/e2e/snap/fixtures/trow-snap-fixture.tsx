import { Dynamic, render } from "solid-js/web"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { BasicTool } from "@opencode-ai/ui/basic-tool"
import { DataProvider, I18nProvider } from "@opencode-ai/ui/context"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { AssistantParts, ToolRegistry } from "@opencode-ai/ui/message-part"
import { TrowBlock } from "@opencode-ai/ui/session-turn-trow-block"
import {
  activitySummaryParts,
  completedParts,
  dismissedQuestionParts,
  failedParts,
  fixtureData,
  labels,
  metadataDetailParts,
  mixedRealToolParts,
  questionDetailParts,
  reasoningOnlyParts,
  runningReasoningParts,
  reasoningWithToolsParts,
  runningParts,
  singleErrorParts,
  singleQuietParts,
  singleResultParts,
  singleRunningParts,
  snapAssistantMessage,
  snapStreamingAssistantMessage,
  toolOutputParts,
  zhI18n,
} from "./trow-snap-fixture-data"

function FileStub() {
  return <div style={{ padding: "8px", color: "var(--fg-weak)", "font-size": "12px" }}>File viewer stub</div>
}

function AssistantPartsCase(props: { parts: Part[]; message?: typeof snapAssistantMessage; working?: boolean }) {
  const message = () => props.message ?? snapAssistantMessage
  return (
    <DataProvider
      data={{ ...fixtureData, part: { [message().id]: props.parts } }}
      directory="/Users/yuhan/PawWork"
    >
      <AssistantParts messages={[message()]} working={props.working} />
    </DataProvider>
  )
}

function describeTool(part: ToolPart) {
  const description = part.state.input?.description
  return `执行命令${typeof description === "string" && description ? ` ${description}` : ""}`
}

function renderTool(prefix: string, openTool?: string) {
  return (part: ToolPart) => {
    const input = part.state.input ?? {}
    const command = typeof input.command === "string" ? input.command : ""
    const description = typeof input.description === "string" ? input.description : undefined
    const output = part.state.status === "completed" ? part.state.output : ""
    return (
      <div data-slot="trow-result-body" data-timeline-anchor={`tool:${part.id}`}>
        <BasicTool
          icon="console"
          status={part.state.status}
          defaultOpen={part.id === openTool}
          stateKey={`${prefix}:${part.id}`}
          trigger={{ title: "执行命令", subtitle: description }}
        >
          <BashOutput command={command} output={output} />
        </BasicTool>
      </div>
    )
  }
}

function BashOutput(props: { command: string; output?: string }) {
  return (
    <div data-component="bash-output">
      <div data-slot="bash-scroll" data-scrollable>
        <pre data-slot="bash-pre">
          <code>{`$ ${props.command}${props.output ? `\n\n${props.output.trim()}` : ""}`}</code>
        </pre>
      </div>
    </div>
  )
}

function renderRegisteredTool(prefix: string, openTool?: string | readonly string[]) {
  return (part: ToolPart) => {
    const component = ToolRegistry.render(part.tool)
    const state = part.state
    const input = state.input ?? {}
    const output = state.status === "completed" ? state.output : undefined
    const metadata = state.status === "completed" ? (state.metadata ?? {}) : {}
    const open =
      Array.isArray(openTool) ? openTool.includes(part.id) : part.id === (openTool ?? "websearch-real")
    return (
      <div data-slot="trow-result-body" data-timeline-anchor={`tool:${part.id}`}>
        <Dynamic
          component={component}
          input={input}
          tool={part.tool}
          metadata={metadata}
          output={output}
          status={state.status}
          defaultOpen={open}
          stateKey={`${prefix}:${part.id}`}
        />
      </div>
    )
  }
}

function TrowSnapFixture() {
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
      <div data-snap="running-current">
        <TrowBlock
          parts={runningParts}
          working
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("running")}
        />
      </div>
      <div data-snap="activity-summary-collapsed">
        <TrowBlock
          parts={activitySummaryParts}
          labels={labels}
        />
      </div>
      <div data-snap="failed-summary-collapsed">
        <TrowBlock
          parts={failedParts}
          labels={labels}
        />
      </div>
      <div data-snap="mixed-collapsed">
        <TrowBlock
          parts={completedParts}
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("collapsed")}
        />
      </div>
      <div
        data-snap="collapsed-followed-by-text"
        data-slot="session-turn-assistant-content"
        style={{ display: "flex", "flex-direction": "column", gap: "12px" }}
      >
        <TrowBlock
          parts={completedParts}
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("collapsed-text")}
        />
        <div data-component="text-part">
          <div data-slot="text-part-body">工具完成后的下一段回复</div>
        </div>
      </div>
      <div data-snap="mixed-expanded">
        <TrowBlock
          parts={completedParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("expanded")}
        />
      </div>
      <div data-snap="inner-bash-expanded">
        <TrowBlock
          parts={completedParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("inner", "third")}
        />
      </div>
      <div data-snap="tool-output-spacing">
        <TrowBlock
          parts={toolOutputParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderRegisteredTool("tool-output", "glob-output")}
        />
      </div>
      <div data-snap="registered-tool-rows">
        <TrowBlock
          parts={mixedRealToolParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderRegisteredTool("registered")}
        />
      </div>
      <div data-snap="question-expanded">
        <TrowBlock
          parts={questionDetailParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderRegisteredTool("question-detail", "question-detail-real")}
        />
      </div>
      <div data-snap="dismissed-question-collapsed">
        <AssistantPartsCase parts={dismissedQuestionParts} />
      </div>
      <div data-snap="metadata-detail-collapsed">
        <TrowBlock
          parts={metadataDetailParts}
          labels={labels}
          describeTool={describeTool}
          renderTool={renderRegisteredTool("metadata-detail-collapsed")}
        />
      </div>
      <div data-snap="metadata-detail-expanded">
        <TrowBlock
          parts={metadataDetailParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderRegisteredTool("metadata-detail-expanded", [
            "metadata-detail-question",
            "metadata-detail-edit",
            "metadata-detail-write",
            "metadata-detail-patch",
          ])}
        />
      </div>
      <div data-snap="reasoning-only">
        <AssistantPartsCase parts={reasoningOnlyParts} />
      </div>
      <div data-snap="running-reasoning">
        <AssistantPartsCase parts={runningReasoningParts} message={snapStreamingAssistantMessage} working />
      </div>
      <div data-snap="reasoning-with-tools">
        <AssistantPartsCase parts={reasoningWithToolsParts} />
      </div>
      <div data-snap="single-command-direct">
        <TrowBlock
          parts={singleQuietParts}
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("single-direct", "single-quiet")}
        />
      </div>
      <div data-snap="single-command-expanded">
        <TrowBlock
          parts={singleResultParts}
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("single-expanded", "single-result")}
        />
      </div>
      <div data-snap="single-command-error">
        <AssistantPartsCase parts={singleErrorParts} />
      </div>
      <div data-snap="single-command-running">
        <TrowBlock
          parts={singleRunningParts}
          working
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("single-running", "single-running")}
        />
      </div>
    </div>
  )
}

export function mountTrowSnapFixture(root: HTMLElement) {
  root.innerHTML = ""
  render(
    () => (
      <I18nProvider value={zhI18n}>
        <MarkedProvider>
          <DataProvider data={fixtureData} directory="/Users/yuhan/PawWork">
            <FileComponentProvider component={FileStub}>
              <TrowSnapFixture />
            </FileComponentProvider>
          </DataProvider>
        </MarkedProvider>
      </I18nProvider>
    ),
    root,
  )
}
