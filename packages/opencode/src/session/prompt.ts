import path from "path"
import os from "os"
import z from "zod"
import * as EffectZod from "@/util/effect-zod"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "@opencode-ai/core/util/log"
import { SessionRevert } from "./revert"
import { inheritMetadata } from "./inherit-metadata"
import * as Session from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { buildActivationReminder, deriveActivatedToolsFromParts, deriveNewlyActivated } from "../tool/tool-info"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Runtime } from "@opencode-ai/core/runtime"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown } from "../config/markdown"
import { OFFICE_EXTS, pathBasename, pathSuffix } from "@opencode-ai/util/file-extensions"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/util/error"
import { SessionProcessor } from "./processor"
import { SessionDiagnostics } from "./diagnostics"
import { LoopRenderer } from "./loop-renderer"
import * as Tool from "@/tool/tool"
import { ExternalResult } from "@/tool/external-result"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@/shell/shell"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { envValueCaseInsensitive, prependBundledTools, stripPathKeys, withoutInternalServerAuthEnv } from "@/util/env"
import { Cause, Deferred, Effect, Exit, Layer, Option, Scope, Context } from "effect"
import { EffectLogger } from "@/effect"
import { InstanceState } from "@/effect"
import { AgentTool, type AgentPromptOps } from "@/tool/agent"
import { SessionRunState } from "./run-state"
import { RunLifecycle } from "./run-lifecycle"
import { EffectBridge } from "@/effect"
import { attachWith, makeRuntime } from "@/effect/run-service"
import { Instance } from "@/project/instance"
import { MemoryFile } from "@/memory/memory"
import { MemoryService } from "@/memory/service"
import { AutomationRunContext, AutomationStepCapError } from "@/automation/run-context"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

const log = Log.create({ service: "session.prompt" })
const elog = EffectLogger.create({ service: "session.prompt" })

function isOrphanedInterruptedTool(part: MessageV2.ToolPart) {
  // The interrupt cleanup marks abandoned tool calls as status:"error" with
  // metadata.interrupted (see processor.ts / session.ts). They are not pending
  // work, so they must not count as live tool calls and re-trigger the loop.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

export type TitleGenerationState = "not_started" | "in_flight" | "completed_before_abort" | "completed_after_abort"

type TitleGenerationProgress = {
  startedAt: number
  completedAt?: number
}

type PromptRuntimeOptions = {
  abortSignal?: AbortSignal
}

export function titleGenerationStateAtAbort(
  progress: TitleGenerationProgress | undefined,
  abortRecordedAt: number,
): TitleGenerationState {
  if (!progress) return "not_started"
  if (progress.completedAt === undefined || progress.completedAt > abortRecordedAt) return "in_flight"
  return "completed_before_abort"
}

export function reconcileTitleGenerationStateAfterCompletion(input: {
  state: TitleGenerationState | undefined
  abortRecordedAt?: number
  completedAt?: number
}): TitleGenerationState | undefined {
  if (
    input.state === "in_flight" &&
    typeof input.abortRecordedAt === "number" &&
    typeof input.completedAt === "number"
  ) {
    return input.completedAt <= input.abortRecordedAt ? "completed_before_abort" : "completed_after_abort"
  }
  return input.state
}

// Single source of truth for product-name strings used in synthetic tool errors. If the brand
// changes, only this constant + assistant-text Chinese summary need to change.
const LOOP_GATE_BRAND = "PawWork"
const LOOP_GATE_BLOCK_PREFIX = `blocked by ${LOOP_GATE_BRAND}`
const LOOP_GATE_STOP_PREFIX = `halted by ${LOOP_GATE_BRAND}`

class BlockedLoopError extends Error {
  constructor(public readonly userFacing: string) {
    super(userFacing)
  }
}
class LoopStopError extends Error {
  constructor(public readonly toolErrorMessage: string) {
    super(toolErrorMessage)
  }
}

type GateOutcome =
  | { kind: "observe" }
  | { kind: "block"; userFacing: string }
  | { kind: "stop"; toolErrorMessage: string }

const applyLoopGate = Effect.fn("SessionPrompt.applyLoopGate")(function* (input: {
  processor: SessionProcessor.Handle
  toolId: string
  args: unknown
  toolCallId: string
  locale?: string
}) {
  const { processor, toolId, args, toolCallId, locale } = input
  const parentID = processor.message.parentID
  if (!parentID) return { kind: "observe" } satisfies GateOutcome

  // Single pass over the message stream — folds errorRecords, syntheticBlockSigKeys, and
  // hasStopped into one walk. applyLoopGate runs before every tool execution, so this saves
  // O(2n) per call vs three independent scans.
  const loopCtx = processor.buildLoopContext(parentID)

  // Once a synthetic stop has been recorded under this parentID, keep the gate
  // closed for any later tool call ai-sdk auto-resumes into. Returning `observe`
  // here would let real tools execute after stop, breaking the "turn ends" contract.
  // We propagate stop without re-recording to avoid duplicate Chinese summary.
  if (loopCtx.hasStopped) {
    return {
      kind: "stop",
      toolErrorMessage: `${LOOP_GATE_STOP_PREFIX}: stop already recorded for this turn`,
    } satisfies GateOutcome
  }

  const inputHashRes = SessionDiagnostics.normalizeInput(args)
  const targetSummaryRes = SessionDiagnostics.targetSummary(toolId, args)
  const targetHash = targetSummaryRes.isFallback ? undefined : SessionDiagnostics.hash(targetSummaryRes.summary)

  const parentLoopState = SessionDiagnostics.deriveParentLoopState({
    errorRecords: loopCtx.errorRecords,
    syntheticBlockSigKeys: loopCtx.syntheticBlockSigKeys,
    parentID,
    currentStepIndex: loopCtx.currentStepIndex,
  })

  const decision = SessionDiagnostics.queryGateAction({
    parentLoopState,
    tool: toolId,
    inputHash: inputHashRes.hash,
    targetHash,
    outcome: "failure",
  })

  if (decision.action === "observe") return { kind: "observe" } satisfies GateOutcome

  const sigState = parentLoopState.signatures[decision.sigKey]
  if (!sigState) return { kind: "observe" } satisfies GateOutcome

  if (decision.action === "block") {
    const userFacing = `${LOOP_GATE_BLOCK_PREFIX}: repeated failed tool request blocked before occurrence ${decision.nextOccurrenceCount}`
    yield* processor.recordSyntheticBlock({
      toolCallId,
      tool: toolId,
      sigKey: decision.sigKey,
      kind: decision.kind,
      outcome: decision.outcome,
      completedCount: decision.completedCount,
      completedFailures: decision.completedFailures,
      nextOccurrenceCount: decision.nextOccurrenceCount,
      attemptedInput: SessionDiagnostics.compactDiagnosticValue(args),
      errorMessage: userFacing,
    })
    return { kind: "block", userFacing } satisfies GateOutcome
  }

  const renderedText = LoopRenderer.render({ tool: toolId, state: sigState, locale })
  const toolErrorMessage = `${LOOP_GATE_STOP_PREFIX}: stop after repeated failures (${decision.nextOccurrenceCount})`
  yield* processor.recordSyntheticStop({
    toolCallId,
    tool: toolId,
    sigKey: decision.sigKey,
    kind: decision.kind,
    outcome: decision.outcome,
    completedCount: decision.completedCount,
    completedFailures: decision.completedFailures,
    nextOccurrenceCount: decision.nextOccurrenceCount,
    attemptedInput: SessionDiagnostics.compactDiagnosticValue(args),
    renderedText,
    toolErrorMessage,
  })
  return { kind: "stop", toolErrorMessage } satisfies GateOutcome
})

// Title generation reads a single user-side seed. When the user message comes
// from a command template the first text part may not be the one carrying the
// invocation metadata — resolvePart can prepend synthetic text in front of a
// `@file` reference, and the stamper only writes commandInvocation onto the
// first text part of the *template*, not the first text part of the assembled
// message. Scan for the part that actually owns the invocation so the title
// model always sees `Command: /<name> <args>` instead of the expanded body.
export function deriveCommandTitleSeed(parts: ReadonlyArray<MessageV2.Part>): string | null {
  const carrier = parts.find((p): p is MessageV2.TextPart => {
    if (p.type !== "text") return false
    const meta = (p as { metadata?: { commandInvocation?: { name?: unknown } } }).metadata
    return typeof meta?.commandInvocation?.name === "string" && meta.commandInvocation.name.length > 0
  })
  if (!carrier) return null
  const meta = (carrier as { metadata?: { commandInvocation?: { name?: unknown; args?: unknown } } }).metadata
  const name = meta?.commandInvocation?.name as string
  const args = typeof meta?.commandInvocation?.args === "string" ? meta.commandInvocation.args : ""
  return "Command: /" + name + (args.length > 0 ? " " + args : "")
}

function officePathOnly(filepath: string) {
  return OFFICE_EXTS.has(pathSuffix(filepath))
}

function attachedLocalFileText(filepath: string, filename?: string) {
  const text = `Attached local file by path: ${filepath}`
  if (!filename || filename === pathBasename(filepath)) return text
  return `${text} (attachment name: ${filename})`
}

type MediaInputKind = "image" | "pdf" | "audio" | "video"

function mediaInputKind(mime: string): MediaInputKind | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime === "application/pdf") return "pdf"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  return undefined
}

function modelCanReadMedia(model: Provider.Model, kind: MediaInputKind) {
  if (model.capabilities.input[kind] === true) return true
  return kind === "pdf" && model.capabilities.input.image === true
}

export interface Interface {
  readonly cancel: (sessionID: SessionID, options?: { source?: string }) => Effect.Effect<boolean>
  readonly prompt: (input: PromptInput, options?: PromptRuntimeOptions) => Effect.Effect<MessageV2.WithParts>
  readonly loop: (input: z.infer<typeof LoopInput>, options?: PromptRuntimeOptions) => Effect.Effect<MessageV2.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts>
  readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const permission = yield* Permission.Service
    const fsys = yield* AppFileSystem.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const runner = Effect.fn("SessionPrompt.runner")(function* () {
      return yield* EffectBridge.make()
    })
    const throwIfAborted = Effect.fn("SessionPrompt.throwIfAborted")(function* (options?: PromptRuntimeOptions) {
      options?.abortSignal?.throwIfAborted()
    })
    // Tracks subagent sessions whose runner.onInterrupt fired during the most recent prompt run.
    // Reset at the start of each prompt() call; written when loop()'s onInterrupt arg fires; read
    // by AgentTool.execute via AgentPromptOps.wasInterrupted to deterministically distinguish
    // "child runner aborted" from "model returned naturally" without racing ctx.abort.aborted.
    const interruptedSessions = new Set<SessionID>()
    const titleGenerationProgress = new Map<SessionID, TitleGenerationProgress>()
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID).pipe(Effect.asVoid),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input),
        // Self-cleaning read: each subagent dispatch reads `wasInterrupted` exactly once after
        // ops.prompt resolves, so deleting on read keeps the Set bounded by concurrent inflight
        // subagents instead of growing across the whole runtime lifetime.
        wasInterrupted: (sessionID: SessionID) => {
          const interrupted = interruptedSessions.has(sessionID)
          if (interrupted) interruptedSessions.delete(sessionID)
          return interrupted
        },
      } satisfies AgentPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID, options?: { source?: string }) {
      const source = options?.source ?? "session.prompt.cancel"
      yield* elog.info("cancel", { sessionID, source })
      yield* state.cancel(sessionID, {
        source,
        reason: "cancel",
        viaCtxAbort: false,
      })
      return true
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: PromptInput["parts"] = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (seen.has(name)) return
          seen.add(name)
          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: MessageV2.WithParts[]
      providerID: ProviderID
      modelID: ModelID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: MessageV2.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info
      const startedAt = Date.now()

      const recordTitleTrace = Effect.fn("SessionPrompt.recordTitleTrace")(function* (trace: {
        completedAt?: number
        success: boolean
        applied?: boolean
        errorName?: string
        errorMessage?: string
      }) {
        titleGenerationProgress.set(input.session.id, {
          startedAt,
          completedAt: trace.completedAt,
        })
        let assistant: MessageV2.WithParts | undefined
        for (let attempt = 0; attempt < 50; attempt++) {
          const messages = yield* sessions.messages({ sessionID: input.session.id })
          assistant = messages.find(
            (message) => message.info.role === "assistant" && message.info.parentID === firstInfo.id,
          )
          if (assistant) break
          yield* Effect.sleep("10 millis")
        }
        if (!assistant || assistant.info.role !== "assistant") {
          yield* elog.warn("title trace target assistant not found", {
            sessionID: input.session.id,
            parentMessageID: firstInfo.id,
          })
          return
        }
        const abort = assistant.info.diagnostics?.abort
        const titleGenerationState = reconcileTitleGenerationStateAfterCompletion({
          state: abort?.title_generation_state,
          abortRecordedAt: abort?.recorded_at,
          completedAt: trace.completedAt,
        })
        yield* sessions.updateMessage({
          ...assistant.info,
          diagnostics: {
            ...(assistant.info.diagnostics ?? {}),
            ...(abort
              ? {
                  abort: {
                    ...abort,
                    title_generation_state: titleGenerationState,
                  },
                }
              : {}),
            title_generation: {
              source: "ensureTitle",
              parent_message_id: firstInfo.id,
              started_at: startedAt,
              completed_at: trace.completedAt,
              success: trace.success,
              applied: trace.applied,
              error_name: trace.errorName,
              error_message: trace.errorMessage,
            },
          },
        })
      })

      const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const commandTitleSeed = deriveCommandTitleSeed(firstUser.parts)

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = commandTitleSeed
        ? [{ role: "user" as const, content: commandTitleSeed }]
        : onlySubtasks
          ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
          : yield* MessageV2.toModelMessagesEffect(context, mdl)
      titleGenerationProgress.set(input.session.id, { startedAt })
      const titleExit = yield* llm
        .stream({
          ...ProviderTransform.streamTimeouts(mdl),
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.exit,
        )
      const completedAt = Date.now()
      if (titleExit._tag === "Failure") {
        const error = Cause.squash(titleExit.cause)
        yield* elog.error("failed to generate title", { error })
        yield* recordTitleTrace({
          completedAt,
          success: false,
          errorName: error instanceof Error ? error.name : undefined,
          errorMessage: error instanceof Error ? error.message : String(error),
        }).pipe(Effect.catchCause(() => Effect.void))
        return
      }
      const text = titleExit.value
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) {
        yield* recordTitleTrace({ completedAt, success: true, applied: false }).pipe(
          Effect.catchCause(() => Effect.void),
        )
        return
      }
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      const setTitleExit = yield* sessions.setTitle({ sessionID: input.session.id, title: t }).pipe(Effect.exit)
      if (Exit.isFailure(setTitleExit)) {
        const error = Cause.squash(setTitleExit.cause)
        yield* elog.error("failed to generate title", { error })
        yield* recordTitleTrace({
          completedAt,
          success: true,
          applied: false,
          errorName: error instanceof Error ? error.name : undefined,
          errorMessage: error instanceof Error ? error.message : String(error),
        }).pipe(Effect.catchCause(() => Effect.void))
        return
      }
      yield* recordTitleTrace({ completedAt, success: true, applied: true }).pipe(Effect.catchCause(() => Effect.void))
    })

    const insertReminders = Effect.fn("SessionPrompt.insertReminders")(function* (input: {
      messages: MessageV2.WithParts[]
      agent: Agent.Info
      session: Session.Info
    }) {
      const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
      if (!userMessage) return input.messages

      if (!Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) {
        if (input.agent.name === "plan") {
          userMessage.parts.push({
            id: PartID.ascending(),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text: PROMPT_PLAN,
            synthetic: true,
          })
        }
        const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
        if (wasPlan && input.agent.name === "build") {
          userMessage.parts.push({
            id: PartID.ascending(),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text: BUILD_SWITCH,
            synthetic: true,
          })
        }
        return input.messages
      }

      const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
      if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
        const plan = Session.plan(input.session)
        if (!(yield* fsys.existsSafe(plan))) return input.messages
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
        return input.messages
      }

      if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

      const plan = Session.plan(input.session)
      const exists = yield* fsys.existsSafe(plan)
      if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
 - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
 - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
 - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
 - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    })

    const resolveTools = Effect.fn("SessionPrompt.resolveTools")(function* (input: {
      agent: Agent.Info
      model: Provider.Model
      session: Session.Info
      tools?: Record<string, boolean>
      processor: SessionProcessor.Handle
      bypassAgentCheck: boolean
      messages: MessageV2.WithParts[]
    }) {
      using _ = log.time("resolveTools")
      const tools: Record<string, AITool> = {}
      const run = yield* runner()
      const promptOps = yield* ops()
      const effectContext = yield* Effect.context()
      const automation = yield* AutomationRunContext.current
      const runInSessionContext = <A>(effect: Effect.Effect<A, any, any>): Effect.Effect<A> =>
        Effect.gen(function* () {
          const session = yield* sessions.get(input.session.id)
          return yield* Effect.promise(
            async () =>
              await Instance.activate({
                activeDirectory: session.executionContext.activeDirectory,
                ownerDirectory: session.executionContext.ownerDirectory,
                project: Instance.project,
                fn: () =>
                  Effect.runPromise(
                    attachWith(effect, { instance: Instance.current }).pipe(
                      Effect.provide(effectContext),
                    ) as Effect.Effect<A, any, never>,
                  ),
              }),
          )
        })
      // Locale travels on the user message (set by the UI from `language.intl()`); capture
      // once here and let every applyLoopGate call in this resolveTools scope share it.
      // Falls back to undefined → English in LoopRenderer. Skip user messages without locale
      // (synthetic continuations like subtask-summary or shell-input) so a zh session keeps
      // rendering Chinese stop summaries even after a synthetic user hop.
      const lastUserMessage = input.messages.findLast(
        (m): m is MessageV2.WithParts & { info: MessageV2.User } =>
          m.info.role === "user" && typeof m.info.locale === "string" && m.info.locale.length > 0,
      )
      const lastUserLocale = lastUserMessage?.info.locale

      // Deferred-tool activation is derived from the session's tool_info parts read
      // directly from storage (NOT the compaction-filtered `messages`), so an activation
      // older than the retained tail still counts without hydrating the full history.
      const activatedTools = deriveActivatedToolsFromParts(MessageV2.toolInfoParts(input.session.id))
      const deferredRuleset = Permission.merge(input.agent.permission, input.session.permission ?? [])
      const deferredAvailable = (id: string) =>
        input.tools?.[id] !== false && !Permission.disabled([id], deferredRuleset).has(id)
      const availableDeferredTools = yield* registry.availableDeferred({ deferredAvailable })

      const context = (args: any, options: ToolExecutionOptions): Tool.Context => ({
        sessionID: input.session.id,
        abort: options.abortSignal!,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps, deferredAvailable },
        agent: input.agent.name,
        messages: input.messages,
        metadata: (val) =>
          input.processor.updateToolCall(options.toolCallId, (match) => {
            if (!["running", "pending"].includes(match.state.status)) return match
            return {
              ...match,
              state: {
                title: val.title,
                metadata: SessionDiagnostics.mergeMetadata(
                  "metadata" in match.state && match.state.metadata && typeof match.state.metadata === "object"
                    ? match.state.metadata
                    : undefined,
                  val.metadata ?? {},
                ),
                status: "running",
                input: args,
                time: { start: Date.now() },
              },
            }
          }),
        ask: (req) =>
          permission
            .ask({
              ...req,
              sessionID: input.session.id,
              tool: { messageID: input.processor.message.id, callID: options.toolCallId },
              ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
              onPending: AutomationRunContext.permissionOnPending(automation),
            })
            .pipe(Effect.ensuring(automation ? automation.clear() : Effect.void), Effect.orDie),
        externalResult: ({ inputSnapshot, decoder }) =>
          Effect.gen(function* () {
            if (automation?.attendance === "unattended") {
              return yield* Effect.fail(new ExternalResult.Error({ reason: "aborted" }))
            }
            const sessionID = input.session.id
            const messageID = input.processor.message.id
            const callID = options.toolCallId
            if (automation) {
              yield* automation.block({ kind: "question", callID })
            }
            const deferred = yield* ExternalResult.register({
              sessionID,
              messageID,
              callID,
              inputSnapshot,
              decoder,
            })
            // Flip the running tool part's metadata flag so the renderer's
            // "preparing..." placeholder transitions to active input controls.
            // The dock / inline marker key on `metadata.externalResultReady`.
            yield* input.processor.updateToolCall(callID, (match) => {
              if (!["running", "pending"].includes(match.state.status)) return match
              const existing =
                "metadata" in match.state && match.state.metadata && typeof match.state.metadata === "object"
                  ? match.state.metadata
                  : {}
              // Mirror ctx.metadata: pending parts are upgraded to running
              // (status / input / time.start). Today's stream order flips the
              // part to running before execute() is invoked, but keeping the
              // two helpers symmetric guards against future re-orderings.
              if (match.state.status === "pending") {
                return {
                  ...match,
                  state: {
                    status: "running",
                    input: args,
                    time: { start: Date.now() },
                    metadata: { ...existing, externalResultReady: true },
                  },
                }
              }
              return {
                ...match,
                state: {
                  ...match.state,
                  metadata: { ...existing, externalResultReady: true },
                },
              }
            })
            // Wire the AbortSignal: a turn abort flips the pending Deferred
            // to ExternalResultError({reason: "aborted"}). Session destroy is
            // handled separately by ExternalResult.onSessionDestroyed.
            //
            // Use the sync registry transition so a racing /tool/respond that
            // lands in the same tick sees a tombstone on its registry lookup
            // and returns 409 instead of fulfilling the Deferred behind us.
            // Deferred.fail is then scheduled asynchronously; the registry is
            // already in the post-abort state by the time that microtask runs.
            const abortHandler = () => {
              const result = ExternalResult.abortPendingSync({ sessionID, messageID, callID })
              if (!result.ok) return
              run
                .promise(Deferred.fail(result.deferred, new ExternalResult.Error({ reason: "aborted" })))
                .catch(() => {})
            }
            const signal = options.abortSignal
            if (signal) {
              if (signal.aborted) {
                abortHandler()
              } else {
                signal.addEventListener("abort", abortHandler, { once: true })
              }
            }
            try {
              const result = yield* Deferred.await(deferred)
              return result as Tool.ExternalResultOutcome
            } finally {
              if (signal) signal.removeEventListener("abort", abortHandler)
              if (automation) yield* automation.clear()
            }
          }),
      })

      for (const item of yield* registry.tools({
        modelID: ModelID.make(input.model.api.id),
        providerID: input.model.providerID,
        agent: input.agent,
        activatedTools,
        deferredAvailable,
      })) {
        const schema = ProviderTransform.schema(input.model, EffectZod.toJsonSchema(item.parameters))
        const aiTool = tool({
          description: item.description,
          inputSchema: jsonSchema(schema),
          execute(args, options) {
            return run.promise(
              Effect.gen(function* () {
                const ctx = context(args, options)
                const outcome = yield* applyLoopGate({
                  processor: input.processor,
                  toolId: item.id,
                  args,
                  toolCallId: options.toolCallId,
                  locale: lastUserLocale,
                })
                if (outcome.kind === "block") return yield* Effect.fail(new BlockedLoopError(outcome.userFacing))
                if (outcome.kind === "stop") return yield* Effect.fail(new LoopStopError(outcome.toolErrorMessage))
                const output = yield* runInSessionContext(
                  Effect.gen(function* () {
                    yield* plugin.trigger(
                      "tool.execute.before",
                      { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                      { args },
                    )
                    if (input.processor.recordToolExecutionStarted) {
                      yield* input.processor.recordToolExecutionStarted({
                        tool: item.id,
                        toolCallID: options.toolCallId,
                      })
                    }
                    let result: Tool.ExecuteResult
                    try {
                      result = yield* item.execute(args, ctx)
                    } catch (error) {
                      if (input.processor.recordToolExecutionFailed) {
                        yield* input.processor.recordToolExecutionFailed({ toolCallID: options.toolCallId, error })
                      }
                      throw error
                    }
                    if (input.processor.recordToolExecutionCompleted) {
                      yield* input.processor.recordToolExecutionCompleted({ toolCallID: options.toolCallId })
                    }
                    const output = {
                      ...result,
                      attachments: result.attachments?.map((attachment) => ({
                        ...attachment,
                        id: PartID.ascending(),
                        sessionID: ctx.sessionID,
                        messageID: input.processor.message.id,
                      })),
                    }
                    yield* plugin.trigger(
                      "tool.execute.after",
                      { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                      output,
                    )
                    return output
                  }),
                )
                if (options.abortSignal?.aborted) {
                  yield* input.processor.completeToolCall(options.toolCallId, output)
                }
                return output
              }),
            )
          },
        })
        tools[item.id] = item.externalResult ? Object.assign(aiTool, { externalResult: true }) : aiTool
      }

      for (const [key, item] of Object.entries(yield* mcp.tools())) {
        const execute = item.execute
        if (!execute) continue

        const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
        const transformed = ProviderTransform.schema(input.model, schema)
        item.inputSchema = jsonSchema(transformed)
        item.execute = (args, opts) =>
          run.promise(
            Effect.gen(function* () {
              const ctx = context(args, opts)
              const outcome = yield* applyLoopGate({
                processor: input.processor,
                toolId: key,
                args,
                toolCallId: opts.toolCallId,
                locale: lastUserLocale,
              })
              if (outcome.kind === "block") return yield* Effect.fail(new BlockedLoopError(outcome.userFacing))
              if (outcome.kind === "stop") return yield* Effect.fail(new LoopStopError(outcome.toolErrorMessage))
              const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* runInSessionContext(
                Effect.gen(function* () {
                  yield* plugin.trigger(
                    "tool.execute.before",
                    { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
                    { args },
                  )
                  const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
                    yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
                    if (input.processor.recordToolExecutionStarted) {
                      yield* input.processor.recordToolExecutionStarted({ tool: key, toolCallID: opts.toolCallId })
                    }
                    try {
                      const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.promise(() =>
                        execute(args, opts),
                      )
                      if (result.isError === true) {
                        // record the failure before completion is marked, so run
                        // observability and the loop gate see isError as a failed execution
                        const failure = parseMcpToolResult(key, result)
                        const error = new Error(
                          failure.kind === "error" ? failure.message : `MCP tool ${key} reported an error`,
                        )
                        if (input.processor.recordToolExecutionFailed) {
                          yield* input.processor.recordToolExecutionFailed({ toolCallID: opts.toolCallId, error })
                        }
                        return yield* Effect.fail(error)
                      }
                      if (input.processor.recordToolExecutionCompleted) {
                        yield* input.processor.recordToolExecutionCompleted({ toolCallID: opts.toolCallId })
                      }
                      return result
                    } catch (error) {
                      if (input.processor.recordToolExecutionFailed) {
                        yield* input.processor.recordToolExecutionFailed({ toolCallID: opts.toolCallId, error })
                      }
                      throw error
                    }
                  }).pipe(
                    Effect.withSpan("Tool.execute", {
                      attributes: {
                        "tool.name": key,
                        "tool.call_id": opts.toolCallId,
                        "session.id": ctx.sessionID,
                        "message.id": input.processor.message.id,
                      },
                    }),
                  )
                  yield* plugin.trigger(
                    "tool.execute.after",
                    { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
                    result,
                  )
                  return result
                }),
              )

              const parsed = parseMcpToolResult(key, result)
              if (parsed.kind === "error") {
                return yield* Effect.fail(new Error(parsed.message))
              }
              const { textParts, attachments } = parsed

              const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
              const metadata = {
                ...result.metadata,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              }

              const output = {
                title: "",
                metadata,
                output: truncated.content,
                attachments: attachments.map((attachment) => ({
                  ...attachment,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: input.processor.message.id,
                })),
                content: result.content,
              }
              if (opts.abortSignal?.aborted) {
                yield* input.processor.completeToolCall(opts.toolCallId, output)
              }
              return output
            }),
          )
        tools[key] = item
      }

      return { tools, availableDeferredTools }
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      subtask: MessageV2.SubtaskPart
      model: Provider.Model
      lastUser: MessageV2.User
      sessionID: SessionID
      session: Session.Info
      msgs: MessageV2.WithParts[]
    }) {
      const { subtask, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { agent: agentTool } = yield* registry.named()
      const taskModel = subtask.model
        ? yield* getModel(subtask.model.providerID, subtask.model.modelID, sessionID)
        : model
      // Re-read live to pick up Enter/Exit transitions made earlier in the same turn.
      const execLive = (yield* sessions.get(sessionID)).executionContext
      const assistantMessage: MessageV2.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: subtask.agent,
        agent: subtask.agent,
        variant: lastUser.model.variant,
        path: { cwd: execLive.activeDirectory, root: execLive.ownerDirectory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: MessageV2.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: AgentTool.id,
        state: {
          status: "running",
          input: {
            prompt: subtask.prompt,
            description: subtask.description,
            subagent_type: subtask.agent,
            command: subtask.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: subtask.prompt,
        description: subtask.description,
        subagent_type: subtask.agent,
        command: subtask.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: AgentTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(subtask.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${subtask.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* agentTool
        .execute(taskArgs, {
          agent: subtask.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          // #26597: ctx.agent here is the subtask's (child) agent, not the dispatcher.
          // Pass the real caller so the agent tool can honor its edit restriction.
          extra: { bypassAgentCheck: true, promptOps, callerAgent: lastUser.agent },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies MessageV2.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            log.error("subtask execution failed", { error, agent: subtask.agent, description: subtask.description })
            return Effect.void
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies MessageV2.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: AgentTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies MessageV2.ToolPart)
      }

      if (!subtask.command) return

      const summaryUserMsg: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the agent tool output above and continue with your task.",
        synthetic: true,
      } satisfies MessageV2.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (
      input: ShellInput,
      ready: Deferred.Deferred<void>,
    ) {
      let output = ""
      let aborted = false
      const { msg, part, cmd, finish } = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(input.sessionID)
          if (session.revert) {
            yield* revert.cleanup(session)
          }
          const agent = yield* agents.get(input.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
            yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
            throw error
          }
          const model = input.model ?? agent.model ?? (yield* lastModel(input.sessionID))
          const userMsg: MessageV2.User = {
            id: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            time: { created: Date.now() },
            role: "user",
            agent: input.agent,
            model: { providerID: model.providerID, modelID: model.modelID },
          }
          yield* sessions.updateMessage(userMsg)
          const userPart: MessageV2.Part = {
            type: "text",
            id: PartID.ascending(),
            messageID: userMsg.id,
            sessionID: input.sessionID,
            text: "The following tool was executed by the user",
            synthetic: true,
          }
          yield* sessions.updatePart(userPart)

          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            sessionID: input.sessionID,
            parentID: userMsg.id,
            mode: input.agent,
            agent: input.agent,
            cost: 0,
            path: { cwd: session.executionContext.activeDirectory, root: session.executionContext.ownerDirectory },
            time: { created: Date.now() },
            role: "assistant",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.modelID,
            providerID: model.providerID,
          }
          yield* sessions.updateMessage(msg)
          const part: MessageV2.ToolPart = {
            type: "tool",
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: input.sessionID,
            tool: "bash",
            callID: ulid(),
            state: {
              status: "running",
              time: { start: Date.now() },
              input: { command: input.command },
            },
          }
          yield* sessions.updatePart(part)
          yield* Deferred.succeed(ready, undefined).pipe(Effect.ignore)

          const sh = Shell.preferred()
          const shellName = (
            process.platform === "win32" ? path.win32.basename(sh, ".exe") : path.basename(sh)
          ).toLowerCase()
          const cwd = session.executionContext.activeDirectory
          const invocations: Record<string, { args: string[] }> = {
            nu: { args: ["-c", input.command] },
            fish: { args: ["-c", input.command] },
            zsh: {
              args: [
                "-l",
                "-c",
                `
                  [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
                  [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
                  cd -- "$OPENCODE_SHELL_CWD" || exit $?
                  unset OPENCODE_SHELL_CWD
                  eval ${JSON.stringify(input.command)}
                `,
                "opencode",
              ],
            },
            bash: {
              args: [
                "-l",
                "-c",
                `
                  shopt -s expand_aliases
                  [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
                  cd -- "$OPENCODE_SHELL_CWD" || exit $?
                  unset OPENCODE_SHELL_CWD
                  eval ${JSON.stringify(input.command)}
                `,
                "opencode",
              ],
            },
            cmd: { args: ["/c", input.command] },
            powershell: { args: ["-NoProfile", "-Command", input.command] },
            pwsh: { args: ["-NoProfile", "-Command", input.command] },
            "": { args: ["-c", input.command] },
          }

          const args = (invocations[shellName] ?? invocations[""]).args
          const shellEnv = yield* restore(
            plugin.trigger("shell.env", { cwd, sessionID: input.sessionID, callID: part.callID }, { env: {} }),
          )

          const shellEnvRecord = shellEnv.env as Record<string, string>
          // Resolve PATH case-insensitively (Windows uses "Path") and strip
          // every casing from the merged env before writing back a canonical
          // PATH, so the spawned child does not receive duplicate keys.
          const currentPath =
            envValueCaseInsensitive(shellEnvRecord, "PATH") ?? envValueCaseInsensitive(process.env, "PATH") ?? ""
          const env = withoutInternalServerAuthEnv({
            ...process.env,
            ...shellEnvRecord,
            TERM: "dumb",
            OFFICECLI_SKIP_UPDATE: "1",
            ...(shellName === "zsh" || shellName === "bash" ? { OPENCODE_SHELL_CWD: cwd } : {}),
          } as Record<string, string>)
          stripPathKeys(env)
          env.PATH = prependBundledTools(currentPath)

          const cmd = ChildProcess.make(sh, args, {
            cwd,
            extendEnv: false,
            env,
            stdin: "ignore",
            forceKillAfter: "3 seconds",
          })

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              if (!msg.time.completed) {
                msg.time.completed = Date.now()
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: Date.now() },
                  input: part.state.input,
                  title: "",
                  metadata: { ...part.state.metadata, output, description: "" },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          return { msg, part, cmd, finish }
        }),
      )

      const exit = yield* Effect.gen(function* () {
        const handle = yield* spawner.spawn(cmd)
        yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
          Effect.gen(function* () {
            output += chunk
            if (part.state.status === "running") {
              part.state.metadata = { ...part.state.metadata, output, description: "" }
              yield* sessions.updatePart(part)
            }
          }),
        )
        yield* handle.exitCode
      }).pipe(Effect.scoped, Effect.orDie, Effect.exit)

      if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
        aborted = true
      }
      yield* finish

      if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.failCause(exit.cause)
      }

      return { info: msg, parts: [part] }
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderID,
      modelID: ModelID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.data.suggestions?.length ? ` Did you mean: ${err.data.suggestions.join(", ")}?` : ""
        yield* bus.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.data.providerID}/${err.data.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.failCause(exit.cause)
    })

    const lastModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    // Expand a command/skill template: positional ($1..$n) + $ARGUMENTS substitution +
    // inline shell interpolation, then trim. A pure text transform shared by the command()
    // endpoint and the inline-skill resolvePart branch. It deliberately does NOT touch
    // agent/model/subtask selection, plugin hooks, or command events — those stay in command().
    const expandCommandTemplate = Effect.fn("SessionPrompt.expandCommandTemplate")(function* (
      cmd: Command.Info,
      args: string,
    ) {
      const raw = args.match(argsRegex) ?? []
      const parsedArgs = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= parsedArgs.length) return ""
        if (position === last) return parsedArgs.slice(argIndex).join(" ")
        return parsedArgs[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      // Function replacer: a string replacement would interpret $-patterns ($$, $&)
      // inside user-typed args instead of inserting them literally.
      let template = withArgs.replaceAll("$ARGUMENTS", () => args)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && args.trim()) {
        template = template + "\n\n" + args
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const sh = Shell.preferred()
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, shellCmd]) => (await Process.text([shellCmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      return template.trim()
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent || (yield* agents.defaultAgent())
      const ag = yield* agents.get(agentName)
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.model ?? ag.model ?? (yield* lastModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.catchDefect(() => Effect.void))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const createdAt = Date.now()
      const messageID = input.messageID ?? MessageID.ascending()
      const info: MessageV2.User = {
        id: messageID,
        role: "user",
        sessionID: input.sessionID,
        time: { created: createdAt },
        tools: input.tools,
        agent: ag.name,
        ...(input.automationID ? { automationID: input.automationID } : {}),
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        locale: input.locale,
        system: input.system,
        format: input.format,
        diagnostics: {
          run_lifecycle: [
            {
              schema_version: RunLifecycle.SCHEMA_VERSION,
              type: "user_message_saved",
              session_id: input.sessionID,
              message_id: messageID,
              at: createdAt,
            },
          ],
        },
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<MessageV2.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if ("text" in c && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && c.blob) {
                  const mime = "mimeType" in c ? c.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mime}]`,
                  })
                }
              }
              pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
            } else {
              const error = Cause.squash(exit.cause)
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              log.info("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              if (yield* fsys.isDir(filepath)) part.mime = "application/x-directory"

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (part.mime === "text/plain") {
                if (officePathOnly(filepath)) {
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: attachedLocalFileText(filepath, part.filename),
                    },
                    { ...part, messageID: info.id, sessionID: input.sessionID },
                  ]
                }

                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) =>
                    execRead(args, { model: mdl }).pipe(Effect.map((result) => ({ model: mdl, result }))),
                  ),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const { model, result } = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    const attachments = result.attachments.filter((attachment) => {
                      const kind = mediaInputKind(attachment.mime)
                      return kind !== undefined && modelCanReadMedia(model, kind)
                    })
                    if (attachments.length) {
                      pieces.push(
                        ...attachments.map((a) =>
                          inheritMetadata(part, {
                            ...a,
                            synthetic: true,
                            filename: a.filename ?? part.filename,
                            messageID: info.id,
                            sessionID: input.sessionID,
                          }),
                        ),
                      )
                    }
                    if (attachments.length < result.attachments.length) {
                      pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
                    }
                  } else {
                    pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push(
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                    { ...part, messageID: info.id, sessionID: input.sessionID },
                  )
                }
                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  log.error("failed to read directory", { error })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                inheritMetadata(part, {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file" as const,
                  url:
                    `data:${part.mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                }),
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("agent", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the agent tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        if (part.type === "skill") {
          // Inline skill chip: resolve the command/skill template and inject it as a
          // synthetic, model-visible text part (mirrors the agent branch above). The
          // structured skill part is persisted only to render the chip in the bubble;
          // it is position-independent because activation reads the parts array, not the
          // text. Argless by design — the surrounding user prose is the turn body.
          const cmd = yield* commands.get(part.name)
          // Unknown skill, or a command/MCP entry masquerading as a skill (the
          // command registry is a shared namespace): keep the chip for the bubble
          // but inject nothing — the full command pipeline handles non-skill entries.
          if (!cmd || cmd.source !== "skill") return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
          const template = yield* expandCommandTemplate(cmd, "")
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: template,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const parts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts },
      )

      const parsed = MessageV2.Info.safeParse(info)
      if (!parsed.success) {
        log.error("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          issues: parsed.error.issues,
        })
      }
      parts.forEach((part, index) => {
        const p = MessageV2.Part.safeParse(part)
        if (p.success) return
        log.error("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          issues: p.error.issues,
          part,
        })
      })

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput, options?: PromptRuntimeOptions) => Effect.Effect<MessageV2.WithParts> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput, options?: PromptRuntimeOptions) {
      yield* throwIfAborted(options)
      interruptedSessions.delete(input.sessionID)
      const session = yield* sessions.get(input.sessionID)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      const permissions: Permission.Ruleset = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        // #26597: the boolean tools map is availability-only — it lists the subagent's structural
        // denies (agent, worktree, todowrite, primary_tools), not what it inherited from its
        // caller. The caller's deny rules are the single source of truth for inheritance and live
        // on session.permission, forwarded at dispatch (tool/agent.ts). Rebuilding from the map
        // alone would drop them, letting a caller regain access through the child. For agent-tool
        // children, carry forward external_directory rules plus every caller deny the map does NOT
        // regenerate: scoped (non-"*") denies (e.g. edit on one path) and whole-tool denies for
        // keys absent from the map — the wildcard "*" and any tool not listed (automate, MCP,
        // custom). Per-tool "*" denies for keys the map lists are regenerated each turn, so
        // dropping them keeps this stable instead of accumulating.
        // NOTE: like upstream #26597 this is forward-deny only — a caller's allow exception (e.g.
        // a read-only "*": deny agent that also allows read) is not preserved, so its subagent
        // loses those tools too. Matching upstream's deriveSubagentSessionPermission; toward deny.
        const toolKeys = new Set(Object.keys(input.tools ?? {}))
        const preserved = session.createdByAgentTool
          ? (session.permission ?? []).filter(
              (rule) =>
                rule.permission === "external_directory" ||
                (rule.action === "deny" && (rule.pattern !== "*" || !toolKeys.has(rule.permission))),
            )
          : []
        const next = [...preserved, ...permissions]
        session.permission = next
        yield* sessions.setPermission({ sessionID: session.id, permission: next })
      }

      yield* throwIfAborted(options)
      if (input.noReply === true) return message
      return yield* loop({ sessionID: input.sessionID, traceMessageID: message.info.id }, options)
    })

    const appendRunLifecycleEvent = Effect.fn("SessionPrompt.appendRunLifecycleEvent")(function* (
      sessionID: SessionID,
      messageID: MessageID,
      event: RunLifecycle.Event,
    ) {
      const found = yield* sessions.findMessage(sessionID, (message) => message.info.id === messageID)
      if (Option.isNone(found)) return
      const info = found.value.info
      if (info.role !== "user") return
      const diagnostics = info.diagnostics ?? {}
      yield* sessions.updateMessage({
        ...info,
        diagnostics: {
          ...diagnostics,
          run_lifecycle: [...(diagnostics.run_lifecycle ?? []), { ...event, message_id: messageID }],
        },
      })
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user")
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 })
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const currentTurnTarget = Effect.fnUntraced(function* (sessionID: SessionID) {
      const latestUser = yield* sessions.findMessage(sessionID, (message) => message.info.role === "user")
      if (Option.isNone(latestUser)) return yield* lastAssistant(sessionID)

      const currentAssistant = yield* sessions.findMessage(
        sessionID,
        (message) => message.info.role === "assistant" && message.info.parentID === latestUser.value.info.id,
      )
      if (Option.isSome(currentAssistant)) return currentAssistant.value
      return latestUser.value
    })

    const shellCancelledAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const message = yield* lastAssistant(sessionID)
      if (message.info.role !== "assistant") return message

      const runningTool = message.parts.find(
        (
          part,
        ): part is MessageV2.ToolPart & {
          state: MessageV2.ToolStateRunning
        } => part.type === "tool" && part.tool === "bash" && part.state.status === "running",
      )
      if (!runningTool) return message

      const output = (
        typeof runningTool.state.metadata?.output === "string" ? runningTool.state.metadata.output : ""
      ).concat("\n\n<metadata>\nUser aborted the command\n</metadata>")
      const info = message.info.time.completed
        ? message.info
        : {
            ...message.info,
            time: {
              ...message.info.time,
              completed: Date.now(),
            },
          }
      const part: MessageV2.ToolPart = {
        ...runningTool,
        state: {
          status: "completed",
          time: { ...runningTool.state.time, end: Date.now() },
          input: runningTool.state.input,
          title: "",
          metadata: { ...runningTool.state.metadata, output, description: "" },
          output,
        },
      }

      if (info !== message.info) {
        yield* sessions.updateMessage(info)
      }
      yield* sessions.updatePart(part)

      return {
        info,
        parts: message.parts.map((item) => (item.id === part.id ? part : item)),
      }
    })

    const runLoop: (sessionID: SessionID) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID: SessionID) {
        const ctx = yield* InstanceState.context
        const automation = yield* AutomationRunContext.current
        const slog = elog.with({ sessionID })
        let structured: unknown | undefined
        let step = 0
        const session = yield* sessions.get(sessionID)

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* slog.info("loop", { step })

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID)

          let lastUser: MessageV2.User | undefined
          let lastAssistant: MessageV2.Assistant | undefined
          let lastAssistantMsg: MessageV2.WithParts | undefined
          let lastFinished: MessageV2.Assistant | undefined
          let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
          for (const msg of MessageV2.stream(sessionID)) {
            if (!lastUser && msg.info.role === "user") lastUser = msg.info
            if (!lastAssistant && msg.info.role === "assistant") {
              lastAssistant = msg.info
              lastAssistantMsg = msg
            }
            if (!lastFinished && msg.info.role === "assistant" && msg.info.finish) lastFinished = msg.info
            if (lastUser && lastFinished) break
            const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
            if (task && !lastFinished) tasks.push(...task)
          }

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
          // Some providers return "stop" even when the assistant message contains tool calls.
          // Keep the loop running so tool results can be sent back to the model, but ignore
          // cleanup-marked interrupted orphans — those are abandoned, not pending work.
          // Skip provider-executed tool parts too — those were fully handled within the
          // provider's stream (e.g. DWS Agent Platform) and don't need a re-loop.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          if (
            lastAssistant?.finish &&
            !["tool-calls"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastUser.id < lastAssistant.id
          ) {
            const tokens = lastFinished?.tokens
            const hasTokenUsage =
              tokens !== undefined &&
              ((tokens.total ?? 0) > 0 ||
                tokens.input > 0 ||
                tokens.output > 0 ||
                tokens.reasoning > 0 ||
                tokens.cache.read > 0 ||
                tokens.cache.write > 0)
            if (lastFinished && lastFinished.summary !== true && hasTokenUsage) {
              const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
              if (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model })) {
                yield* compaction.create({
                  sessionID,
                  agent: lastUser.agent,
                  model: lastUser.model,
                  auto: true,
                })
                continue
              }
            }
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is MessageV2.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* slog.warn("loop exit with orphaned interrupted tool", {
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            yield* slog.info("exiting loop")
            break
          }

          step++
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ subtask: task, model, lastUser, sessionID, session, msgs })
            continue
          }

          if (task?.type === "compaction") {
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
              executionContext: session.executionContext,
            })
            if (result === "stop") break
            continue
          }

          if (
            lastFinished &&
            lastFinished.summary !== true &&
            (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
          ) {
            yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
            continue
          }

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps = agent.steps ?? Infinity
          const automationHardStepCap = automation?.stepCap ?? 50
          if (automation && step > automationHardStepCap) {
            throw new AutomationStepCapError(automationHardStepCap)
          }
          const isLastStep = step >= maxSteps
          msgs = yield* insertReminders({ messages: msgs, agent, session })
          const diagnostics = SessionDiagnostics.consumeReminders({ messages: msgs, parentID: lastUser.id })
          if (diagnostics.text) {
            const userMessage = msgs.findLast((msg) => msg.info.role === "user" && msg.info.id === lastUser.id)
            userMessage?.parts.push({
              id: PartID.ascending(),
              messageID: lastUser.id,
              sessionID,
              type: "text",
              text: diagnostics.text,
              synthetic: true,
            })
          }
          yield* Effect.forEach(diagnostics.parts, (part) => sessions.updatePart(part), {
            concurrency: "unbounded",
            discard: true,
          })

          // Tool description self-claims of "now available" don't move small models;
          // a <system-reminder> in the user message of the very next step does. Source the
          // just-activated ids from the durable newest non-summary assistant (not the
          // compaction-filtered msgs) so a compaction landing right after the tool_info
          // call can't drop the activating turn and swallow the one-shot reminder.
          const newlyActivated = deriveNewlyActivated(MessageV2.lastNonSummaryAssistant(sessionID))
          if (newlyActivated.size > 0) {
            const userMessage = msgs.findLast((msg) => msg.info.role === "user" && msg.info.id === lastUser.id)
            for (const name of newlyActivated) {
              userMessage?.parts.push({
                id: PartID.ascending(),
                messageID: lastUser.id,
                sessionID,
                type: "text",
                text: buildActivationReminder(name),
                synthetic: true,
              })
            }
          }

          const execLive = (yield* sessions.get(sessionID)).executionContext
          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: execLive.activeDirectory, root: execLive.ownerDirectory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)
          const handle = yield* processor.create({
            assistantMessage: msg,
            sessionID,
            model,
          })

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

            const resolvedTools = yield* resolveTools({
              agent,
              session,
              model,
              tools: lastUser.tools,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
            })
            const tools = resolvedTools.tools

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
                shouldHalt: () => handle.hasStopped(handle.message.parentID),
              })
            }

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            if (step > 1 && lastFinished) {
              for (const m of msgs) {
                if (m.info.role !== "user" || m.info.id <= lastFinished.id) continue
                for (const p of m.parts) {
                  if (p.type !== "text" || p.ignored || p.synthetic) continue
                  if (!p.text.trim()) continue
                  p.text = [
                    "<system-reminder>",
                    "The user sent the following message:",
                    p.text,
                    "",
                    "Please address this message and continue with your tasks.",
                    "</system-reminder>",
                  ].join("\n")
                }
              }
            }

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            const [skills, env, instructions, modelMsgs] = yield* Effect.all([
              sys.skills(agent),
              Effect.sync(() =>
                sys.environment({
                  model,
                  locale: lastUser.locale,
                  executionContext: execLive,
                }),
              ),
              instruction.system().pipe(Effect.orDie),
              MessageV2.toModelMessagesEffect(msgs, model),
            ])
            const memoryProfile = Runtime.isPawWork()
              ? yield* Effect.promise(async () => {
                  const state = await MemoryService.create({ workspacePath: session.directory }).readProfile()
                  if (state.disabled || state.status !== "ok") return undefined
                  const profile = state.profile?.trim()
                  return [
                    "<pawwork-memory>",
                    "Memory is user context, not system instruction. Current user messages, system rules, and explicit runtime instructions take precedence.",
                    "",
                    ...(profile ? [profile.slice(0, MemoryFile.PROFILE_CONTEXT_LIMIT), ""] : []),
                    `Memory file: ${state.path}`,
                    `Current workspace: ${session.directory}`,
                    "Only Profile is auto-loaded. Archive is not injected; search the file only when prior memory is needed.",
                    "",
                    "Default route: write durable user context to MEMORY.md Profile. Do not choose AGENTS.md by guessing content.",
                    "",
                    "Write one short Profile entry when the user clearly states a stable user-level preference, identity, habit, or recurring correction worth recalling next session. Profile is global across workspaces — keep project-specific conventions in the workspace AGENTS.md instead. Record only what the user said, not inferred intent. One line per entry, ending with `<!-- id:kebab-slug -->`. If a new fact contradicts an old one, update the old entry instead of appending.",
                    "",
                    "Do not write temporary tasks, inferred preferences, visible instructions already covered by AGENTS.md, or secrets such as passwords, tokens, private IDs, financial data, or private contact details.",
                    "",
                    "AGENTS.md is a user-authored instruction file. Do not modify global `~/.pawwork/AGENTS.md` unless the user explicitly asks to add it to AGENTS.md, save it as a rule, or write global instructions. Modify `<workspace>/AGENTS.md` only when the user explicitly asks to save a project rule.",
                    "",
                    "If the user explicitly says remember, forget, change memory, 忘记, or 删掉, update the matching entry and acknowledge briefly. Otherwise keep memory writes quiet unless it is the first automatic memory write in this session.",
                    "",
                    state.profileTooLarge
                      ? "Profile currently exceeds the soft limit. Move the least useful entries to `## Archive` before appending new ones."
                      : "If Profile approaches 2000 chars, move the least useful old entries to `## Archive` before appending.",
                    "</pawwork-memory>",
                  ].join("\n")
                }).pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      log.warn("memory profile load failed", { error: String(error) })
                      return undefined
                    }),
                  ),
                )
              : undefined
            const system = [
              ...env,
              ...(skills ? [skills] : []),
              ...instructions,
              ...(memoryProfile ? [memoryProfile] : []),
            ]
            const format = lastUser.format ?? { type: "text" as const }
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
              tools,
              availableDeferredTools: resolvedTools.availableDeferredTools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
            })

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              if (format.type === "json_schema") {
                handle.message.error = new MessageV2.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            if (result === "stop") return "break" as const
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
            }
            return "continue" as const
          }).pipe(Effect.ensuring(instruction.clear(handle.message.id)))
          if (outcome === "break") break
          continue
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    const loop: (
      input: z.infer<typeof LoopInput>,
      options?: PromptRuntimeOptions,
    ) => Effect.Effect<MessageV2.WithParts> = Effect.fn(
      "SessionPrompt.loop",
    )(function* (input: z.infer<typeof LoopInput>, options?: PromptRuntimeOptions) {
      const onInterrupt = (meta?: {
        source?: string
        reason?: string
        viaCtxAbort?: boolean
        propagationPoint?: string
        recordedAt?: number
      }) =>
        Effect.gen(function* () {
          interruptedSessions.add(input.sessionID)
          // Sweep any pending compaction marker first — a user message with
          // a `compaction` part but no summary assistant child. Covers two
          // race shapes: (1) marker just written, processCompaction has not
          // reached its placeholder yet; (2) a normal SessionPrompt.prompt
          // landed while compaction was running and persisted its user
          // message before awaitRun, so currentTurnTarget now points at
          // that newer user instead of the marker. Both leave the marker
          // orphaned and the divider would render `failed` even though the
          // cancel was a clean abort.
          //
          // Semantic boundary — only handle the *newest* compaction marker,
          // and only if it lacks a summary child. Do NOT iterate older
          // markers looking for any orphan. A historical orphan (e.g. left
          // by a crashed prior session) is rendered `failed` by the divider
          // because it *actually* failed; rewriting it as `aborted` here
          // would attribute a past crash to the current cancel and stamp
          // it with this cancel's `propagation_point`, which is a lie.
          //
          // The "newest marker = the marker this cancel can be attributed
          // to" invariant rests on two upstream guarantees: (a) the Runner
          // is per-session and serial — only one work effect can be writing
          // a marker at any moment; (b) the prelude path uses rejectIfBusy
          // (run-state.ts ~L173), so a second /summarize cannot land
          // concurrently and produce a competing newer marker. If either
          // guarantee weakens, this sweep would need run-local attribution
          // (e.g. capture a high-water-mark message id at work entry and
          // only match markers above it).
          const pendingMarker = yield* sessions.findMessage(input.sessionID, (m) =>
            m.info.role === "user" && m.parts.some((p) => p.type === "compaction"),
          )
          if (Option.isSome(pendingMarker)) {
            const markerInfo = pendingMarker.value.info
            if (markerInfo.role === "user") {
              const summaryChild = yield* sessions.findMessage(
                input.sessionID,
                (m) =>
                  m.info.role === "assistant" &&
                  m.info.parentID === markerInfo.id &&
                  m.info.summary === true,
              )
              if (Option.isNone(summaryChild)) {
                const sess = yield* sessions.get(input.sessionID)
                const exec = sess.executionContext
                const recordedAt = meta?.recordedAt ?? Date.now()
                const abortError = new MessageV2.AbortedError({ message: "Compaction aborted" })
                const placeholder: MessageV2.Assistant = {
                  id: MessageID.ascending(),
                  role: "assistant",
                  parentID: markerInfo.id,
                  sessionID: input.sessionID,
                  mode: "compaction",
                  agent: "compaction",
                  variant: markerInfo.model.variant,
                  summary: true,
                  path: {
                    cwd: exec.activeDirectory,
                    root: exec.ownerDirectory,
                  },
                  cost: 0,
                  tokens: {
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                  modelID: markerInfo.model.modelID,
                  providerID: markerInfo.model.providerID,
                  time: {
                    created: recordedAt,
                    completed: recordedAt,
                  },
                  error: abortError.toObject(),
                  finish: "error",
                  diagnostics: {
                    abort: {
                      source: meta?.source,
                      reason: meta?.reason,
                      title_generation_state: titleGenerationStateAtAbort(
                        titleGenerationProgress.get(input.sessionID),
                        recordedAt,
                      ),
                      propagation_point:
                        meta?.propagationPoint ?? "session.prompt.loop.onInterrupt.compaction_prelude",
                      error_name: abortError.name,
                      error_message: "Compaction aborted",
                      via_ctx_abort: meta?.viaCtxAbort,
                      recorded_at: recordedAt,
                    },
                  },
                }
                yield* sessions.updateMessage(placeholder)
                return { info: placeholder, parts: [] }
              }
            }
          }
          const assistant = yield* currentTurnTarget(input.sessionID)
          if (assistant.info.role === "assistant") {
            const error = assistant.info.error
            const errorMessage =
              error && "data" in error && error.data && typeof error.data === "object" && "message" in error.data
                ? String(error.data.message)
                : undefined
            const recordedAt = meta?.recordedAt ?? Date.now()
            yield* sessions.updateMessage({
              ...assistant.info,
              diagnostics: {
                ...(assistant.info.diagnostics ?? {}),
                abort: {
                  ...(assistant.info.diagnostics?.abort ?? {}),
                  source: meta?.source,
                  reason: meta?.reason,
                  title_generation_state: titleGenerationStateAtAbort(
                    titleGenerationProgress.get(input.sessionID),
                    recordedAt,
                  ),
                  propagation_point: meta?.propagationPoint ?? "session.prompt.loop.onInterrupt",
                  error_name: error?.name,
                  error_message: errorMessage,
                  via_ctx_abort: meta?.viaCtxAbort,
                  recorded_at: recordedAt,
                },
              },
            })
            return yield* lastAssistant(input.sessionID)
          }
          return assistant
        })
      const work = Effect.gen(function* () {
        yield* throwIfAborted(options)
        // Two reasons busy goes first. (1) The compaction part event must
        // not race ahead of `session.status: busy` — the divider's
        // "no summary + not working" branch would otherwise flash the
        // legacy-orphan failed state for one render frame. (2) The work
        // effect runs inside the Runner's fiber, so a cancel arriving here
        // hits a Running runner and Fiber.interrupt fires — SessionRunState
        // .cancel's no-runner path can't silently drop the abort.
        yield* status.set(input.sessionID, { type: "busy" })
        if (input.prelude?.type === "compaction") {
          // revert.cleanup is part of the prelude's atomic transaction: a
          // busy-rejected /summarize must leave revert state untouched, so
          // the cleanup runs only after the Runner has won the Idle slot.
          // Previously this lived in the route handler, which meant a
          // BusyError-rejected compact had already mutated session.revert
          // by the time the rejection fired.
          yield* revert.cleanup(yield* sessions.get(input.sessionID))
          // Agent derivation must read the post-cleanup message list — a
          // reverted session has discarded-but-still-physically-present
          // user messages, and revert.cleanup is what drops them. Picking
          // the agent from the latest remaining user keeps /summarize
          // honoring the revert point's last active agent.
          let agent = input.prelude.agent
          if (!agent) {
            const msgs = yield* sessions.messages({ sessionID: input.sessionID })
            agent = yield* agents.defaultAgent()
            for (let i = msgs.length - 1; i >= 0; i--) {
              const info = msgs[i].info
              if (info.role === "user") {
                agent = info.agent || agent
                break
              }
            }
          }
          yield* compaction.create({
            sessionID: input.sessionID,
            agent,
            model: input.prelude.model,
            auto: input.prelude.auto,
          })
        }
        return yield* runLoop(input.sessionID)
      })
      // rejectIfBusy is the prelude path's safety net: a prelude's side
      // effects (writing the compaction marker) only run when ensureRunning
      // actually executes `work`, and that only happens from the Idle branch
      // of the runner's atomic ref-modify. Without this flag a `loop` call
      // that arrives while another run is in flight would silently
      // `awaitRun(existing)` and resolve to the previous run's result — the
      // requested compaction would never happen, but the route would return
      // `true`. UI callers handle the resulting `Session.BusyError` (mapped
      // to HTTP 409 by middleware) by queuing the compact action through the
      // followup machinery and auto-retrying after the session idles.
      const runLifecycle = input.traceMessageID
        ? {
            onWaitStarted: (event: RunLifecycle.Event) =>
              appendRunLifecycleEvent(input.sessionID, input.traceMessageID!, event),
            onWaitEnded: (event: RunLifecycle.Event) =>
              appendRunLifecycleEvent(input.sessionID, input.traceMessageID!, event),
          }
        : undefined
      yield* throwIfAborted(options)
      return yield* state.ensureRunning(input.sessionID, onInterrupt, work, {
        rejectIfBusy: input.prelude !== undefined,
        runLifecycle,
      })
    })

    const shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.shell")(
      function* (input: ShellInput) {
        const ready = yield* Deferred.make<void>()
        return yield* state.startShell(
          input.sessionID,
          () => shellCancelledAssistant(input.sessionID),
          shellImpl(input, ready),
          ready,
        )
      },
    )

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* elog.info("command", { sessionID: input.sessionID, command: input.command, agent: input.agent })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent ?? (yield* agents.defaultAgent())

      const template = yield* expandCommandTemplate(cmd, input.arguments)

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* lastModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = yield* agents.get(agentName)
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true

      const stampedTemplate = (() => {
        const trimmedArgs = (input.arguments ?? "").trim()
        const displayArgs = trimmedArgs.length > 80 ? trimmedArgs.slice(0, 79) + "…" : trimmedArgs
        const invocation: Record<string, unknown> = {
          name: cmd.name,
          source: cmd.source ?? "command",
          icon: "command",
        }
        if (trimmedArgs.length > 0) invocation.args = trimmedArgs
        if (displayArgs.length > 0) invocation.displayArgs = displayArgs
        let stampedFirstText = false
        return templateParts.map((part) => {
          if (part.type === "text") {
            const prevMeta = (part as { metadata?: Record<string, unknown> }).metadata ?? {}
            const nextMeta: Record<string, unknown> = { ...prevMeta, commandTemplate: true }
            if (!stampedFirstText) {
              nextMeta.commandInvocation = invocation
              stampedFirstText = true
            }
            return { ...part, metadata: nextMeta }
          }
          if (part.type === "file") {
            const prevMeta = (part as { metadata?: Record<string, unknown> }).metadata ?? {}
            return { ...part, metadata: { ...prevMeta, commandTemplate: true } }
          }
          return part
        })
      })()

      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
              status: "completed" as const,
              recent_events: [],
            },
          ]
        : [...stampedTemplate, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultAgent())) : agentName
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* lastModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        locale: input.locale,
        variant: input.variant,
      })
      yield* bus.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(SessionCompaction.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        Agent.defaultLayer,
        SystemPrompt.defaultLayer,
        LLM.defaultLayer,
        Bus.layer,
        CrossSpawnSpawner.defaultLayer,
      ),
    ),
  ),
)
const { runPromise } = makeRuntime(Service, defaultLayer)

export const PromptInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
  // Stamped onto the user message when an automation run drives this prompt, so
  // the conversation can mark which turns it sent rather than the user typing.
  automationID: z.string().optional(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  agent: z.string().optional(),
  locale: z.string().optional(),
  noReply: z.boolean().optional(),
  tools: z
    .record(z.string(), z.boolean())
    .optional()
    .describe("@deprecated tools and permissions have been merged, you can set permissions on the session itself now"),
  format: MessageV2.Format.optional(),
  system: z.string().optional(),
  variant: z.string().optional(),
  parts: z.array(
    z.discriminatedUnion("type", [
      MessageV2.TextPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "TextPartInput",
        }),
      MessageV2.FilePart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "FilePartInput",
        }),
      MessageV2.AgentPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "AgentPartInput",
        }),
      MessageV2.SkillPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "SkillPartInput",
        }),
      MessageV2.SubtaskPart.omit({
        messageID: true,
        sessionID: true,
      })
        .partial({
          id: true,
        })
        .meta({
          ref: "SubtaskPartInput",
        }),
    ]),
  ),
})
export type PromptInput = z.infer<typeof PromptInput>

export async function prompt(input: PromptInput) {
  // automationID is automation-run provenance, set only by the runner through
  // promptWithAutomationContext (which also provides the trusted
  // AutomationRunContext). Strip any client-supplied value here so HTTP callers
  // (POST /:sessionID/message, /prompt_async both route through this) cannot
  // forge the "sent via automation" attribution.
  return runPromise((svc) => svc.prompt(PromptInput.parse({ ...input, automationID: undefined })))
}

export async function promptWithAutomationContext(
  input: PromptInput,
  context: import("@/automation/run-context").AutomationRunContext,
  options?: PromptRuntimeOptions,
) {
  return runPromise((svc) =>
    svc
      .prompt(PromptInput.parse(input), options)
      .pipe(Effect.provideService(AutomationRunContext.service, context)),
  )
}

export async function resolvePromptParts(template: string) {
  return runPromise((svc) => svc.resolvePromptParts(z.string().parse(template)))
}

export async function cancel(sessionID: SessionID, options?: { source?: string }) {
  return runPromise((svc) => svc.cancel(SessionID.zod.parse(sessionID), options))
}

export const LoopInput = z.object({
  sessionID: SessionID.zod,
  traceMessageID: MessageID.zod.optional(),
  // Optional setup that must run inside the Runner's fiber — keeps the
  // cancel-during-setup signal alive (see loop() above).
  prelude: z
    .object({
      type: z.literal("compaction"),
      // Optional: when omitted the loop derives the agent from the last
      // user message AFTER revert.cleanup has run. Derivation must happen
      // post-cleanup or a reverted session would pick the agent off a
      // discarded user message.
      agent: z.string().optional(),
      model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
      auto: z.boolean(),
    })
    .optional(),
})

export async function loop(input: z.infer<typeof LoopInput>) {
  return runPromise((svc) => svc.loop(LoopInput.parse(input)))
}

export const ShellInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
  agent: z.string(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  command: z.string(),
})
export type ShellInput = z.infer<typeof ShellInput>

export async function shell(input: ShellInput) {
  return runPromise((svc) => svc.shell(ShellInput.parse(input)))
}

export const CommandInput = z.object({
  messageID: MessageID.zod.optional(),
  sessionID: SessionID.zod,
  agent: z.string().optional(),
  model: z.string().optional(),
  locale: z.string().optional(),
  arguments: z.string(),
  command: z.string(),
  variant: z.string().optional(),
  parts: z
    .array(
      z.discriminatedUnion("type", [
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        }).partial({
          id: true,
        }),
      ]),
    )
    .optional(),
})
export type CommandInput = z.infer<typeof CommandInput>

export async function command(input: CommandInput) {
  return runPromise((svc) => svc.command(CommandInput.parse(input)))
}

type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: { text?: string; blob?: string; mimeType?: string; uri: string } }
  | { type: string }

export type McpToolOutcome =
  | { kind: "error"; message: string }
  | {
      kind: "ok"
      textParts: string[]
      attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
    }

// MCP signals tool failure via `isError` on a normally-returned result — the SDK
// client does not throw for it, and the AI SDK only emits tool-error for thrown
// errors. Surfacing it as an error outcome here routes the call into the regular
// tool-error channel (error-state part, error fingerprint for the loop gate)
// instead of recording a completed success.
/** @internal Exported for testing */
export function parseMcpToolResult(
  key: string,
  result: { isError?: boolean; content: McpContentItem[] },
): McpToolOutcome {
  const textParts: string[] = []
  const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
  for (const contentItem of result.content) {
    if (contentItem.type === "text" && "text" in contentItem) textParts.push(contentItem.text)
    else if (contentItem.type === "image" && "data" in contentItem) {
      attachments.push({
        type: "file",
        mime: contentItem.mimeType,
        url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
      })
    } else if (contentItem.type === "resource" && "resource" in contentItem) {
      const { resource } = contentItem
      if (resource.text) textParts.push(resource.text)
      if (resource.blob) {
        attachments.push({
          type: "file",
          mime: resource.mimeType ?? "application/octet-stream",
          url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
          filename: resource.uri,
        })
      }
    }
  }
  if (result.isError === true) {
    return {
      kind: "error",
      message: textParts.join("\n\n").trim() || `MCP tool ${key} reported an error without details`,
    }
  }
  return { kind: "ok", textParts, attachments }
}

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
  shouldHalt?: () => boolean
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // After a synthetic stop, ai-sdk auto-resume must not capture a structured output:
      // the turn ended, and emitting an answer here contradicts that contract.
      if (input.shouldHalt?.()) {
        throw new Error(`${LOOP_GATE_STOP_PREFIX}: stop already recorded for this turn`)
      }
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export * as SessionPrompt from "./prompt"
