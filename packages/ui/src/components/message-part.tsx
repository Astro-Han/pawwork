import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
  onCleanup,
  Index,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import {
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  Session,
  TextPart,
  ToolPart,
  UserMessage,
  Todo,
  QuestionAnswer,
  QuestionInfo,
} from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useFileComponent } from "../context/file"
import { useDialog } from "../context/dialog"
import { type UiI18n, useI18n } from "../context/i18n"
import { BasicTool, GenericTool } from "./basic-tool"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { Collapsible } from "./collapsible"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { ToolErrorCard } from "./tool-error-card"
import { DiffChanges } from "./diff-changes"
import { Markdown } from "./markdown"
import { ImagePreview } from "./image-preview"
import { getDirectory as _getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { checksum } from "@opencode-ai/core/util/encode"
import { Tooltip } from "./tooltip"
import { IconButton } from "./icon-button"
import { Spinner } from "./spinner"
import { TextShimmer } from "./text-shimmer"
import { AnimatedCountList } from "./tool-count-summary"
import { ToolStatusTitle } from "./tool-status-title"
import { patchFiles } from "./apply-patch-file"
import { animate } from "motion"
import { useLocation } from "@solidjs/router"
import { attached, inline, kind } from "./message-file"
import { normalizeShellOutput } from "../util/shell-output"

// Slice 11b.1: display chrome (ShellSubmessage, Diagnostic/DiagnosticsDisplay,
// ToolFileAccordion) + the `PART_MAPPING["tool"]` dispatcher moved to
// `./message-part-tool-display`. The import is intentionally a side-effect
// for the registry assignment; the named imports below keep the legacy
// tool renderers (still in this file) wired to the same primitives.
import {
  DiagnosticsDisplay,
  ShellSubmessage,
  ToolFileAccordion,
  getDiagnostics,
} from "./message-part-tool-display"

// Slice 11b.1: types extracted to `./message-part-types.ts`. Re-exported
// here for back-compat with existing imports (`session-turn.tsx`,
// storybook fixtures, …) until the public contract is migrated to
// import the dedicated types file directly.
import type {
  MessageProps,
  SessionAction,
  UserActions,
  MessagePartProps,
  PartComponent,
} from "./message-part-types"
export type { MessageProps, SessionAction, UserActions, MessagePartProps, PartComponent }

// Slice 11b.1: the part / tool registries live in `./message-part-registry`.
// Re-export here so existing callers (session-turn.tsx, stories, tests)
// keep working until they migrate to import from the dedicated file.
import { PART_MAPPING, Part, registerPartComponent, registerTool, getTool, ToolRegistry } from "./message-part-registry"
export { PART_MAPPING, Part, registerPartComponent, registerTool, getTool, ToolRegistry }

// Slice 11b.1: paced-streaming text helpers + markdown wrappers extracted
// to `./message-part-markdown`. Imported here so the legacy callsites
// inside this file (text part renderer, tools that show paths) continue
// to resolve until those callsites move to their own modules.
import {
  MessageMarkdown,
  PacedMarkdown,
  createPacedValue,
  getDirectory,
  isAbsoluteLikePath,
  joinWorkspacePath,
  relativizeProjectPath,
} from "./message-part-markdown"

import type { IconProps } from "./icon"

// Slice 11b.1: tool-info, agent tone helpers, and tool-state narrowing
// helpers extracted to `./message-part-tool-info`. Public surface (the
// `buildToolInfo` / `ToolInfo` export) preserved through re-exports
// directly from `./tool-info`.
export { buildToolInfo, type ToolInfo } from "./tool-info"
import { agentTitle, enterWorktreeSubtitle, exitWorktreeSubtitle } from "./tool-info"
import {
  agentTones,
  agentPalette,
  getToolInfo,
  taskAgent,
  toolStateError,
  toolStateMetadata,
  tone,
} from "./message-part-tool-info"
export { getToolInfo }

// Exported wrapper for regression tests (Task 16) — accepts a ToolPart so tests can pass a full
// part object and get back the derived icon/title/subtitle without mocking the switch internals.
// Implementation lives in ./tool-info.ts as a pure module so tests can import it without
// triggering message-part's SolidJS/Kobalte side effects at module load.

// Slice 11b.1: assistant-side rendering (AssistantParts / AssistantMessageDisplay /
// ContextToolGroup / ExaOutput / urls helper) extracted to a dedicated module.
// Re-exported here for back-compat with existing consumers (session-turn.tsx,
// stories, tests).
import {
  AssistantMessageDisplay,
  AssistantParts,
  ExaOutput,
} from "./assistant-message-display"
export { AssistantMessageDisplay, AssistantParts }

// Slice 11b.1: user-side rendering (UserMessageDisplay + HighlightedText)
// extracted to a dedicated module.
import { UserMessageDisplay } from "./user-message-display"
export { UserMessageDisplay }

// Slice 11b.1: session-routing helpers extracted to
// `./message-part-session-link`. Imported here for the task / agent tool
// renderer below; the tool dispatcher (now in `./message-part-tool-display`)
// imports them directly.
import { sessionLink, taskSession } from "./message-part-session-link"

// Slice 11b.1: legacy assistant grouping helpers extracted to
// `./message-part-render-groups`. These are intentionally separate from
// the v2 `./message-part-group.ts` (both own a `groupParts` symbol; the
// shapes differ). Imported here under explicit aliases to keep the
// existing callsites readable.
import {
  CONTEXT_GROUP_TOOLS,
  HIDDEN_TOOLS,
  groupParts as legacyGroupParts,
  index,
  isContextGroupTool,
  latestDefined,
  list,
  partDefaultOpen,
  renderable,
  same,
  sameGroups,
  type PartGroup,
  type PartRef,
} from "./message-part-render-groups"

export function Message(props: MessageProps) {
  return (
    <>
      <Show when={props.message.role === "user"}>
        <UserMessageDisplay message={props.message as UserMessage} parts={props.parts} actions={props.actions} />
      </Show>
      <Show when={props.message.role === "assistant"}>
        <AssistantMessageDisplay
          message={props.message as AssistantMessage}
          parts={props.parts}
          showAssistantCopyPartID={props.showAssistantCopyPartID}
          showReasoningSummaries={props.showReasoningSummaries}
        />
      </Show>
    </>
  )
}



// Slice 11b.1: types live in `./message-part-types.ts`; re-export for
// back-compat. The next slice should retire the re-export once consumers
// are migrated to the dedicated types file.
import type { ToolProps, ToolComponent } from "./message-part-types"
export type { ToolProps, ToolComponent }

// Slice 11b.1: text / reasoning / compaction renderers + MessageDivider
// live in `./message-part-core-renderers`. Imported here as a
// side-effect (registers PART_MAPPING entries) plus a named re-export so
// `session-turn.tsx` can keep importing `MessageDivider` from the
// message-part barrel.
import { MessageDivider } from "./message-part-core-renderers"
export { MessageDivider }

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.offset) args.push("offset=" + props.input.offset)
    if (props.input.limit) args.push("limit=" + props.input.limit)
    const loaded = createMemo(() => {
      if (props.status !== "completed") return []
      const value = props.metadata.loaded
      if (!value || !Array.isArray(value)) return []
      return value.filter((p): p is string => typeof p === "string")
    })
    return (
      <>
        <BasicTool
          {...props}
          icon="glasses"
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: props.input.filePath ? getFilename(props.input.filePath) : "",
            args,
          }}
        />
        <For each={loaded()}>
          {(filepath) => (
            <div data-component="tool-loaded-file">
              <Icon name="enter" />
              <span>
                {i18n.t("ui.tool.loaded")} {relativizeProjectPath(filepath, data.directory)}
              </span>
            </div>
          )}
        </For>
      </>
    )
  },
})

ToolRegistry.register({
  name: "list",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="bullet-list"
        trigger={{ title: i18n.t("ui.tool.list"), subtitle: getDirectory(props.input.path || "/") }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <MessageMarkdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.glob"),
          subtitle: getDirectory(props.input.path || "/"),
          args: props.input.pattern ? ["pattern=" + props.input.pattern] : [],
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <MessageMarkdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.pattern) args.push("pattern=" + props.input.pattern)
    if (props.input.include) args.push("include=" + props.input.include)
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: getDirectory(props.input.path || "/"),
          args,
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <MessageMarkdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const url = createMemo(() => {
      const value = props.input.url
      if (typeof value !== "string") return ""
      return value
    })
    return (
      <BasicTool
        {...props}
        hideDetails
        icon="window-cursor"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.webfetch")} active={pending()} />
              </span>
              <Show when={!pending() && url()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  class="clickable subagent-link"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  {url()}
                </a>
              </Show>
            </div>
            <Show when={!pending() && url()}>
              <div data-component="tool-action">
                <Icon name="square-arrow-top-right" />
              </div>
            </Show>
          </div>
        }
      />
    )
  },
})

ToolRegistry.register({
  name: "websearch",
  render(props) {
    const i18n = useI18n()
    const query = createMemo(() => {
      const value = props.input.query
      if (typeof value !== "string") return ""
      return value
    })

    return (
      <BasicTool
        {...props}
        icon="window-cursor"
        trigger={{
          title: i18n.t("ui.tool.websearch"),
          subtitle: query(),
          subtitleClass: "exa-tool-query",
        }}
      >
        <ExaOutput output={props.output} />
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "enter-worktree",
  render(props) {
    const i18n = useI18n()
    const subtitle = createMemo(() => enterWorktreeSubtitle(props.input, props.metadata, i18n))
    return (
      <BasicTool
        {...props}
        hideDetails
        icon="worktree"
        trigger={{ title: i18n.t("ui.tool.worktree.enter"), subtitle: subtitle() }}
      />
    )
  },
})

ToolRegistry.register({
  name: "exit-worktree",
  render(props) {
    const i18n = useI18n()
    const subtitle = createMemo(() => exitWorktreeSubtitle(props.metadata, i18n))
    return (
      <BasicTool
        {...props}
        hideDetails
        icon="worktree"
        trigger={{ title: i18n.t("ui.tool.worktree.exit"), subtitle: subtitle() }}
      />
    )
  },
})

// Render function extracted so both "task" (legacy) and "agent" registrations share one reference.
const renderAgentToolPart: ToolComponent = (props) => {
  const data = useData()
  const i18n = useI18n()
  const location = useLocation()
  const childSessionId = createMemo(() => {
    const value = props.metadata.sessionId
    if (typeof value === "string" && value) return value
    return taskSession(props.input, location.pathname, data.store.session, data.store.agent)
  })
  const agent = createMemo(() => taskAgent(props.input.subagent_type, data.store.agent))
  const title = createMemo(() => agent().name ?? i18n.t("ui.tool.agent.default"))
  const tone = createMemo(() => agent().color)
  const subtitle = createMemo(() => {
    const value = props.input.description
    if (typeof value === "string" && value) return value
    return childSessionId()
  })
  const running = createMemo(() => props.status === "pending" || props.status === "running")

  const href = createMemo(() => sessionLink(childSessionId(), location.pathname, data.sessionHref))
  const clickable = createMemo(() => !!(childSessionId() && (data.navigateToSession || href())))

  const open = () => {
    const id = childSessionId()
    if (!id) return
    if (data.navigateToSession) {
      data.navigateToSession(id)
      return
    }
    const value = href()
    if (value) window.location.assign(value)
  }

  const navigate = (event: MouseEvent) => {
    if (!data.navigateToSession) return
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    open()
  }

  const trigger = () => (
    <div data-component="task-tool-card">
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <Show when={running()}>
            <span data-component="task-tool-spinner" style={{ color: tone() ?? "var(--brand-primary)" }}>
              <Spinner />
            </span>
          </Show>
          <span data-component="task-tool-title" style={{ color: tone() ?? "var(--fg-strong)" }}>
            {title()}
          </span>
          <Show when={subtitle()}>
            <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
          </Show>
        </div>
      </div>
      <Show when={clickable()}>
        <div data-component="task-tool-action">
          <Icon name="square-arrow-top-right" />
        </div>
      </Show>
    </div>
  )

  return (
    <BasicTool
      icon="agent"
      status={props.status}
      trigger={trigger()}
      hideDetails
      triggerHref={href()}
      clickable={clickable()}
      onTriggerClick={navigate}
    />
  )
}

ToolRegistry.register({ name: "task", render: renderAgentToolPart }) // agent-rename:legacy-render
ToolRegistry.register({ name: "agent", render: renderAgentToolPart })

ToolRegistry.register({
  name: "bash",
  render(props) {
    const i18n = useI18n()
    const pending = () => props.status === "pending" || props.status === "running"
    const sawPending = pending()
    const text = createMemo(() => {
      const cmd = props.input.command ?? props.metadata.command ?? ""
      const out = normalizeShellOutput(props.output || props.metadata.output || "")
      return `$ ${cmd}${out ? "\n\n" + out : ""}`
    })
    const [copied, setCopied] = createSignal(false)

    const handleCopy = async () => {
      const content = text()
      if (!content) return
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }

    return (
      <BasicTool
        {...props}
        icon="console"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.shell")} active={pending()} />
              </span>
              <Show when={!pending() && props.input.description}>
                <ShellSubmessage text={props.input.description} animate={sawPending} />
              </Show>
            </div>
          </div>
        }
      >
        <div data-component="bash-output">
          <div data-slot="bash-copy">
            <Tooltip
              value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              placement="top"
              gutter={4}
            >
              <IconButton
                icon={copied() ? "check" : "copy"}
                size="small"
                variant="secondary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              />
            </Tooltip>
          </div>
          <div data-slot="bash-scroll" data-scrollable>
            <pre data-slot="bash-pre">
              <code>{text()}</code>
            </pre>
          </div>
        </div>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.metadata?.filediff?.file || props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    return (
      <div data-component="edit-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer
          trigger={
            <div data-component="edit-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("ui.messagePart.title.edit")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff} />
                </Show>
              </div>
            </div>
          }
        >
          <Show when={path()}>
            <ToolFileAccordion
              path={path()}
              actions={
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff!} />
                </Show>
              }
            >
              <div data-component="edit-content">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  before={{
                    name: props.metadata?.filediff?.file || props.input.filePath,
                    contents: props.metadata?.filediff?.before || props.input.oldString,
                  }}
                  after={{
                    name: props.metadata?.filediff?.file || props.input.filePath,
                    contents: props.metadata?.filediff?.after || props.input.newString,
                  }}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    return (
      <div data-component="write-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer
          trigger={
            <div data-component="write-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("ui.messagePart.title.write")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">{/* <DiffChanges diff={diff} /> */}</div>
            </div>
          }
        >
          <Show when={props.input.content && path()}>
            <ToolFileAccordion path={path()}>
              <div data-component="write-content">
                <Dynamic
                  component={fileComponent}
                  mode="text"
                  file={{
                    name: props.input.filePath,
                    contents: props.input.content,
                    cacheKey: checksum(props.input.content),
                  }}
                  overflow="scroll"
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "apply_patch",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const files = createMemo(() => patchFiles(props.metadata.files))
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const single = createMemo(() => {
      const list = files()
      if (list.length !== 1) return
      return list[0]
    })
    const [expanded, setExpanded] = createSignal<string[]>([])
    let seeded = false

    createEffect(() => {
      const list = files()
      if (list.length === 0) return
      if (seeded) return
      seeded = true
      setExpanded(list.filter((f) => f.type !== "delete").map((f) => f.filePath))
    })

    const subtitle = createMemo(() => {
      const count = files().length
      if (count === 0) return ""
      return `${count} ${i18n.t(count > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
    })

    return (
      <Show
        when={single()}
        fallback={
          <div data-component="apply-patch-tool">
            <BasicTool
              {...props}
              icon="code-lines"
              defer
              trigger={{
                title: i18n.t("ui.tool.patch"),
                subtitle: subtitle(),
              }}
            >
              <Show when={files().length > 0}>
                <Accordion
                  multiple
                  data-scope="apply-patch"
                  style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
                  value={expanded()}
                  onChange={(value) => setExpanded(Array.isArray(value) ? value : value ? [value] : [])}
                >
                  <For each={files()}>
                    {(file) => {
                      const active = createMemo(() => expanded().includes(file.filePath))
                      const [visible, setVisible] = createSignal(false)

                      createEffect(() => {
                        if (!active()) {
                          setVisible(false)
                          return
                        }

                        requestAnimationFrame(() => {
                          if (!active()) return
                          setVisible(true)
                        })
                      })

                      return (
                        <Accordion.Item value={file.filePath} data-type={file.type}>
                          <StickyAccordionHeader>
                            <Accordion.Trigger>
                              <div data-slot="apply-patch-trigger-content">
                                <div data-slot="apply-patch-file-info">
                                  <FileIcon node={{ path: file.relativePath, type: "file" }} />
                                  <div data-slot="apply-patch-file-name-container">
                                    <Show when={file.relativePath.includes("/")}>
                                      <span data-slot="apply-patch-directory">{`\u202A${getDirectory(file.relativePath)}\u202C`}</span>
                                    </Show>
                                    <span data-slot="apply-patch-filename">{getFilename(file.relativePath)}</span>
                                  </div>
                                </div>
                                <div data-slot="apply-patch-trigger-actions">
                                  <Switch>
                                    <Match when={file.type === "add"}>
                                      <span data-slot="apply-patch-change" data-type="added">
                                        {i18n.t("ui.patch.action.created")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "delete"}>
                                      <span data-slot="apply-patch-change" data-type="removed">
                                        {i18n.t("ui.patch.action.deleted")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "move"}>
                                      <span data-slot="apply-patch-change" data-type="modified">
                                        {i18n.t("ui.patch.action.moved")}
                                      </span>
                                    </Match>
                                    <Match when={true}>
                                      <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                                    </Match>
                                  </Switch>
                                  <Icon name="chevron-grabber-vertical" />
                                </div>
                              </div>
                            </Accordion.Trigger>
                          </StickyAccordionHeader>
                          <Accordion.Content>
                            <Show when={visible()}>
                              <div data-component="apply-patch-file-diff">
                                <Dynamic component={fileComponent} mode="diff" fileDiff={file.view.fileDiff} />
                              </div>
                            </Show>
                          </Accordion.Content>
                        </Accordion.Item>
                      )
                    }}
                  </For>
                </Accordion>
              </Show>
            </BasicTool>
          </div>
        }
      >
        <div data-component="apply-patch-tool">
          <BasicTool
            {...props}
            icon="code-lines"
            defer
            trigger={
              <div data-component="edit-trigger">
                <div data-slot="message-part-title-area">
                  <div data-slot="message-part-title">
                    <span data-slot="message-part-title-text">
                      <TextShimmer text={i18n.t("ui.tool.patch")} active={pending()} />
                    </span>
                    <Show when={!pending()}>
                      <span data-slot="message-part-title-filename">{getFilename(single()!.relativePath)}</span>
                    </Show>
                  </div>
                  <Show when={!pending() && single()!.relativePath.includes("/")}>
                    <div data-slot="message-part-path">
                      <span data-slot="message-part-directory">{getDirectory(single()!.relativePath)}</span>
                    </div>
                  </Show>
                </div>
                <div data-slot="message-part-actions">
                  <Show when={!pending()}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Show>
                </div>
              </div>
            }
          >
            <ToolFileAccordion
              path={single()!.relativePath}
              actions={
                <Switch>
                  <Match when={single()!.type === "add"}>
                    <span data-slot="apply-patch-change" data-type="added">
                      {i18n.t("ui.patch.action.created")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "delete"}>
                    <span data-slot="apply-patch-change" data-type="removed">
                      {i18n.t("ui.patch.action.deleted")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "move"}>
                    <span data-slot="apply-patch-change" data-type="modified">
                      {i18n.t("ui.patch.action.moved")}
                    </span>
                  </Match>
                  <Match when={true}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Match>
                </Switch>
              }
            >
              <div data-component="apply-patch-file-diff">
                <Dynamic component={fileComponent} mode="diff" fileDiff={single()!.view.fileDiff} />
              </div>
            </ToolFileAccordion>
          </BasicTool>
        </div>
      </Show>
    )
  },
})

ToolRegistry.register({
  name: "todowrite",
  render(props) {
    const i18n = useI18n()
    const todos = createMemo(() => {
      const meta = props.metadata?.todos
      if (Array.isArray(meta)) return meta

      const input = props.input.todos
      if (Array.isArray(input)) return input

      return []
    })

    const subtitle = createMemo(() => {
      const list = todos()
      if (list.length === 0) return ""
      return `${list.filter((t: Todo) => t.status === "completed").length}/${list.length}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="checklist"
        trigger={{
          title: i18n.t("ui.tool.todos"),
          subtitle: subtitle(),
        }}
      >
        <Show when={todos().length}>
          <div data-component="todos">
            <For each={todos()}>
              {(todo: Todo) => (
                <div data-slot="message-part-todo-item" data-state={todo.status}>
                  <Show
                    when={todo.status === "in_progress"}
                    fallback={
                      <Icon
                        name={todo.status === "completed" ? "circle-check" : "circle"}
                        style={{ color: "var(--icon-base)", "flex-shrink": "0" }}
                      />
                    }
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        "align-items": "center",
                        "justify-content": "center",
                        width: "16px",
                        height: "16px",
                        "flex-shrink": "0",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: "13px",
                          height: "13px",
                          "border-radius": "9999px",
                          border: "1.5px solid var(--border-weak)",
                          "border-top-color": "var(--brand-primary)",
                          animation: "var(--animate-pw-spin)",
                        }}
                      />
                    </span>
                  </Show>
                  <span
                    data-slot="message-part-todo-content"
                    data-completed={todo.status === "completed" ? "completed" : undefined}
                  >
                    {todo.content}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "question",
  render(props) {
    const i18n = useI18n()
    const questions = createMemo(() => (props.input.questions ?? []) as QuestionInfo[])
    const answers = createMemo(() => (props.metadata.answers ?? []) as QuestionAnswer[])
    const completed = createMemo(() => answers().length > 0)

    const subtitle = createMemo(() => {
      const count = questions().length
      if (count === 0) return ""
      if (completed()) return i18n.t("ui.question.subtitle.answered", { count })
      return `${count} ${i18n.t(count > 1 ? "ui.common.question.other" : "ui.common.question.one")}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen={completed()}
        icon="bubble-5"
        trigger={{
          title: i18n.t("ui.tool.questions"),
          subtitle: subtitle(),
        }}
      >
        <Show when={completed()}>
          <div data-component="question-answers">
            <For each={questions()}>
              {(q, i) => {
                const answer = () => answers()[i()] ?? []
                return (
                  <div data-slot="question-answer-item">
                    <div data-slot="question-text">{q.question}</div>
                    <div data-slot="answer-text">
                      {answer().length ? answer().join(", ") : i18n.t("ui.question.answer.skipped")}
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "skill",
  render(props) {
    const i18n = useI18n()
    const title = createMemo(() => props.input.name || i18n.t("ui.tool.skill"))
    const running = createMemo(() => props.status === "pending" || props.status === "running")

    const titleContent = () => <TextShimmer text={title()} active={running()} />

    const trigger = () => (
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <span data-slot="basic-tool-tool-title" class="capitalize agent-title">
            {titleContent()}
          </span>
        </div>
      </div>
    )

    return <BasicTool icon="brain" status={props.status} trigger={trigger()} hideDetails />
  },
})
