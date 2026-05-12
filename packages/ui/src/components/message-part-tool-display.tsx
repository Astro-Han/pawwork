import { createMemo, For, Match, onMount, Show, Switch, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useLocation } from "@solidjs/router"
import { animate } from "motion"
import { getFilename } from "@opencode-ai/core/util/path"
import { useData } from "../context"
import { useI18n } from "../context/i18n"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { GenericTool } from "./basic-tool"
import { ToolErrorCard } from "./tool-error-card"
import { getDirectory } from "./message-part-markdown"
import { PART_MAPPING, ToolRegistry } from "./message-part-registry"
import { toolStateError, toolStateMetadata } from "./message-part-tool-info"
import { sessionLink } from "./message-part-session-link"

/**
 * Slice 11b.1: tool dispatcher + display chrome extracted from
 * `message-part.tsx` per design doc §1.
 *
 *   `ShellSubmessage`      animated subtitle used by the bash renderer
 *                          (kept here because the diff/edit accordions
 *                          and the bash card share the same
 *                          motion-styled inline label primitive).
 *   `Diagnostic` / `getDiagnostics` / `DiagnosticsDisplay`
 *                          render LSP diagnostics that flow through the
 *                          edit / write / apply_patch tools.
 *   `ToolFileAccordion`    sticky-header accordion wrapper used by the
 *                          file-modifying tool renderers.
 *   side-effect            assigns `PART_MAPPING["tool"]`. Importing this
 *                          module registers the assistant-side tool
 *                          dispatcher into the part registry.
 *
 * Keep imports here cycle-free: this module imports the registry but the
 * registry must NOT import back from any renderer.
 */

export function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef: HTMLSpanElement | undefined
  let valueRef: HTMLSpanElement | undefined

  onMount(() => {
    if (!props.animate) return
    requestAnimationFrame(() => {
      if (widthRef) {
        animate(widthRef, { width: "auto" }, { type: "spring", visualDuration: 0.25, bounce: 0 })
      }
      if (valueRef) {
        animate(valueRef, { opacity: 1, filter: "blur(0px)" }, { duration: 0.32, ease: [0.16, 1, 0.3, 1] })
      }
    })
  })

  return (
    <span data-component="shell-submessage">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}

export interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

export function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): Diagnostic[] {
  if (!diagnosticsByFile || !filePath) return []
  const diagnostics = diagnosticsByFile[filePath] ?? []
  return diagnostics.filter((d) => d.severity === 1).slice(0, 3)
}

export function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const i18n = useI18n()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

export function ToolFileAccordion(props: { path: string; actions?: JSX.Element; children: JSX.Element }) {
  const value = createMemo(() => props.path || "tool-file")

  return (
    <Accordion
      multiple
      data-scope="apply-patch"
      style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
      defaultValue={[value()]}
    >
      <Accordion.Item value={value()}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div data-slot="apply-patch-trigger-content">
              <div data-slot="apply-patch-file-info">
                <FileIcon node={{ path: props.path, type: "file" }} />
                <div data-slot="apply-patch-file-name-container">
                  <Show when={props.path.includes("/")}>
                    <span data-slot="apply-patch-directory">{`‪${getDirectory(props.path)}‬`}</span>
                  </Show>
                  <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
                </div>
              </div>
              <div data-slot="apply-patch-trigger-actions">
                {props.actions}
                <Icon name="chevron-grabber-vertical" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content>{props.children}</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  )
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = () => props.part as ToolPart
  if (part().tool === "todowrite") return null

  const hideQuestion = createMemo(
    () => part().tool === "question" && (part().state.status === "pending" || part().state.status === "running"),
  )

  const emptyInput: Record<string, any> = {}

  const input = () => part().state?.input ?? emptyInput
  const partMetadata = () => toolStateMetadata(part().state)
  // Hide synthetic stop tool parts while keeping metadata available for exported diagnostics.
  const hideSyntheticStop = createMemo(
    () => partMetadata().diagnostics?.loop?.loopAction === "stop",
  )
  const taskId = createMemo(() => {
    if (part().tool !== "task" && part().tool !== "agent") return // agent-rename:legacy-render
    const value = partMetadata().sessionId
    if (typeof value === "string" && value) return value
  })
  const taskHref = createMemo(() => {
    if (part().tool !== "task" && part().tool !== "agent") return // agent-rename:legacy-render
    return sessionLink(taskId(), useLocation().pathname, data.sessionHref)
  })
  const taskSubtitle = createMemo(() => {
    if (part().tool !== "task" && part().tool !== "agent") return undefined // agent-rename:legacy-render
    const value = input().description
    if (typeof value === "string" && value) return value
    return taskId()
  })

  const render = createMemo(() => ToolRegistry.render(part().tool) ?? GenericTool)

  return (
    <Show when={!hideQuestion() && !hideSyntheticStop()}>
      <div data-component="tool-part-wrapper">
        <Switch>
          <Match when={part().state.status === "error" && toolStateError(part().state)}>
            {(error) => {
              const cleaned = error().replace("Error: ", "")
              if (part().tool === "question" && cleaned.includes("dismissed this question")) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-13-regular text-fg-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.dismissed")}
                    </span>
                  </div>
                )
              }
              // Cancelled question: the run was interrupted before the user
              // saw or answered. Show a short, action-oriented hint instead of
              // the raw "Question cancelled..." string so non-technical users
              // know they can just re-ask. Identify by metadata.interrupted
              // (written by processor cleanup) so this is independent of the
              // exact error string used in the backend. See #419.
              if (part().tool === "question" && partMetadata()?.interrupted === true) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-13-regular text-fg-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.interrupted")}
                    </span>
                  </div>
                )
              }
              return (
                <ToolErrorCard
                  tool={part().tool}
                  error={error()}
                  defaultOpen={props.defaultOpen}
                  subtitle={taskSubtitle()}
                  href={taskHref()}
                />
              )
            }}
          </Match>
          <Match when={true}>
            <Dynamic
              component={render()}
              input={input()}
              tool={part().tool}
              metadata={partMetadata()}
              // @ts-expect-error
              output={part().state.output}
              status={part().state.status}
              hideDetails={props.hideDetails}
              defaultOpen={props.defaultOpen}
            />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
