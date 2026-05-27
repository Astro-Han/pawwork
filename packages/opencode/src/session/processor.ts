import { Cause, Deferred, Effect, Layer, Context, Scope, Schedule } from "effect"
import * as Stream from "effect/Stream"
import { Bus } from "@/bus"
import { Config } from "@/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { buildModelRetryDecision, selectRetryTimeoutPolicy, type RetryTimeoutPolicy } from "./retry-decision"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { SessionDiagnostics } from "./diagnostics"
import { classifyToolFailure } from "./tool-failure"
import type { Provider } from "@/provider"
import { ProviderTransform } from "@/provider"
import { ExternalResult } from "@/tool/external-result"
import { errorMessage } from "@/util/error"
import { Log } from "@opencode-ai/core/util/log"
import { isRecord } from "@/util/record"
import { InstanceState } from "@/effect/instance-state"
import { TurnChange } from "./turn-change"
import { LLMTrace } from "./llm-trace"
import { RunObservability } from "./run-observability"
import { currentLifecycleCloseAction, lifecycleCloseActionMeta } from "./lifecycle-provenance"

const log = Log.create({ service: "session.processor" })
const TOOL_CLEANUP_TIMEOUT_MS = 1_000
export const REASONING_FIRST_ATTEMPT_CONNECT_TIMEOUT_MS = 60_000
export const REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS = 120_000
const LOCAL_LIFECYCLE_CLOSE_INTERRUPTION_MESSAGE = "The run was interrupted by a local lifecycle close."

export type Result = "compact" | "stop" | "continue"

export type Event = LLM.Event

export interface Handle {
  readonly message: MessageV2.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly recordToolExecutionStarted?: (input: { tool: string; toolCallID: string }) => Effect.Effect<void>
  readonly recordToolExecutionCompleted?: (input: { toolCallID: string }) => Effect.Effect<void>
  readonly recordToolExecutionFailed?: (input: { toolCallID: string; error?: unknown }) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  readonly errorRecords: (parentID: MessageV2.Assistant["parentID"]) => SessionDiagnostics.ToolErrorRecord[]
  readonly syntheticBlockSigKeys: (parentID: MessageV2.Assistant["parentID"]) => string[]
  readonly hasStopped: (parentID: MessageV2.Assistant["parentID"]) => boolean
  readonly buildLoopContext: (parentID: MessageV2.Assistant["parentID"]) => {
    errorRecords: SessionDiagnostics.ToolErrorRecord[]
    syntheticBlockSigKeys: string[]
    hasStopped: boolean
    currentStepIndex?: number
  }
  readonly recordSyntheticBlock: (input: {
    toolCallId: string
    tool: string
    sigKey: string
    kind: SessionDiagnostics.SignatureKind
    outcome: SessionDiagnostics.LoopOutcome
    completedCount: number
    completedFailures?: number
    nextOccurrenceCount: number
    attemptedInput?: unknown
    errorMessage: string
  }) => Effect.Effect<void>
  readonly recordSyntheticStop: (input: {
    toolCallId: string
    tool: string
    sigKey: string
    kind: SessionDiagnostics.SignatureKind
    outcome: SessionDiagnostics.LoopOutcome
    completedCount: number
    completedFailures?: number
    nextOccurrenceCount: number
    attemptedInput?: unknown
    renderedText: string
    toolErrorMessage: string
  }) => Effect.Effect<void>
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
  attemptID?: RunObservability.AttemptID
  materialized?: boolean
  executionStarted?: boolean
}

type ToolInterruptionPhase = "tool_input_generation" | "tool_call_materialized_without_execution" | "tool_execution"

const TOOL_INTERRUPTION_ERRORS: Record<ToolInterruptionPhase, string> = {
  tool_execution: "Tool execution aborted",
  tool_call_materialized_without_execution: "Tool call was prepared, but the tool did not run before the interruption.",
  tool_input_generation: "Tool call generation interrupted before the tool ran.",
}

function watchdogPhase(error: unknown): "connect" | "silent_stream" | "unknown" | undefined {
  const message = errorMessage(error).toLowerCase()
  if (!message.includes("llm stream connection timed out")) return undefined
  if (message.includes("without provider progress")) return "connect"
  return "silent_stream"
}

function attemptStreamTimeouts(
  model: Provider.Model,
  automaticStreamRetriesUsed: number,
  streamInput: Pick<LLM.StreamInput, "connectTimeoutMs">,
  boundary: RunObservability.SideEffectBoundarySnapshot,
): { connectTimeoutMs?: number } {
  if (streamInput.connectTimeoutMs !== undefined) return {}
  if (!model.capabilities.reasoning) return {}
  const firstAttemptCanAutoRetry = RunObservability.boundaryAllowsBeforeProgressRetry(boundary)
  if (automaticStreamRetriesUsed === 0 && !firstAttemptCanAutoRetry) {
    return { connectTimeoutMs: ProviderTransform.REASONING_GLOBAL_CONNECT_TIMEOUT_MS }
  }
  // #918: fail fast on the first stalled reasoning-model attempt, then give
  // the one safe retry the pre-existing slow-start protection window.
  return {
    connectTimeoutMs:
      automaticStreamRetriesUsed > 0
        ? REASONING_SAFE_RETRY_CONNECT_TIMEOUT_MS
        : REASONING_FIRST_ATTEMPT_CONNECT_TIMEOUT_MS,
  }
}

function retryTimeoutPolicyFor(
  model: Provider.Model,
  automaticStreamRetriesUsed: number,
  streamInput: Pick<LLM.StreamInput, "connectTimeoutMs">,
  boundary: RunObservability.SideEffectBoundarySnapshot,
): RetryTimeoutPolicy {
  return selectRetryTimeoutPolicy({
    modelSupportsReasoning: model.capabilities.reasoning,
    explicitConnectTimeout: streamInput.connectTimeoutMs !== undefined,
    beforeProgressAutoRetryAllowed: RunObservability.boundaryAllowsBeforeProgressRetry(boundary),
    safeRecoveryAttempt: automaticStreamRetriesUsed,
  })
}

function recoveryInterruptionMessage(recovery: NonNullable<RunObservability.Summary["incident"]>["recovery"] | undefined) {
  switch (recovery?.reason) {
    case "no_visible_output_or_tool_execution":
      return "Connection lost. Retry failed — please resend your message."
    case "visible_output_without_tool_execution":
      return "Connection lost during response. Please resend to continue."
    case "partial_tool_input_without_execution":
    case "tool_call_materialized_without_execution":
      return "Connection lost during a tool operation. Please resend — the tool did not complete."
    case "tool_execution_started":
    case "unsafe_side_effect_started":
    case "side_effect_facts_incomplete":
      return "Connection lost. Please check whether the last operation completed before resending."
    case "local_lifecycle_close":
      return LOCAL_LIFECYCLE_CLOSE_INTERRUPTION_MESSAGE
    case "user_cancel":
      return "The run was cancelled by the user."
    default:
      return undefined
  }
}

type PendingLoopAction = {
  loopAction: "block" | "stop"
  tool: string
  sigKey: string
  kind: SessionDiagnostics.SignatureKind
  outcome: SessionDiagnostics.LoopOutcome
  completedCount: number
  completedFailures?: number
  nextOccurrenceCount: number
  attemptedInput?: unknown
  errorMessage: string
  renderedText?: string
}

interface ProcessorContext extends Input {
  directory: string
  toolcalls: Record<string, ToolCall>
  pendingLoopActions: Record<string, PendingLoopAction>
  pendingToolUpdates: Record<string, Array<(part: MessageV2.ToolPart) => MessageV2.ToolPart>>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
  reasoningPartIDsByAttempt: Record<string, Set<PartID>>
  trace: LLMTrace.Recorder
  runTrace: RunObservability.Recorder
  attemptCount: number
  currentAttemptID: RunObservability.AttemptID | undefined
  streamError: boolean
  /** Set by policy() signalTerminal when free_quota_exhausted is detected. Read
   *  and reset to undefined at the start of halt() to avoid cross-call staling. */
  terminalClassification: import("./retry-classification").RetryClassification | undefined
}

type StreamEvent = Event

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Session.Service
  | Config.Service
  | Bus.Service
  | Snapshot.Service
  | LLM.Service
  | Permission.Service
  | Plugin.Service
  | SessionSummary.Service
  | SessionStatus.Service
  | TurnChange.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const llm = yield* LLM.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const turnChange = yield* TurnChange.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const instanceContext = yield* InstanceState.context
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        directory: instanceContext.directory,
        toolcalls: {},
        pendingLoopActions: {},
        pendingToolUpdates: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
        reasoningPartIDsByAttempt: {},
        trace: LLMTrace.createRecorder({
          traceID: input.assistantMessage.id,
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          parentMessageID: input.assistantMessage.parentID,
          providerID: input.model.providerID,
          modelID: input.model.id,
          agent: input.assistantMessage.agent,
          variant: input.assistantMessage.variant,
          createdAt: input.assistantMessage.time.created,
        }),
        runTrace: RunObservability.createRecorder({
          runID: RunObservability.makeRunID(input.assistantMessage.id),
          traceID: input.assistantMessage.id,
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          parentMessageID: input.assistantMessage.parentID,
          providerID: input.model.providerID,
          modelID: input.model.id,
          createdAt: input.assistantMessage.time.created,
          monotonicStartMs: performance.now(),
        }),
        attemptCount: 0,
        currentAttemptID: undefined,
        streamError: false,
        terminalClassification: undefined,
      }
      let aborted = false
      const slog = log.clone().tag("sessionID", input.sessionID).tag("messageID", input.assistantMessage.id)

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return
        }
        return { call, part }
      })

      const toolCallAttemptID = (toolCallID: string, fallbackAttemptID = ctx.currentAttemptID) =>
        ctx.toolcalls[toolCallID]?.attemptID ?? fallbackAttemptID

      const recordToolExecutionStarted = Effect.fn("SessionProcessor.recordToolExecutionStarted")(function* (input: {
        tool: string
        toolCallID: string
      }) {
        const call = ctx.toolcalls[input.toolCallID]
        const attemptID = toolCallAttemptID(input.toolCallID)
        if (call) {
          call.executionStarted = true
          call.attemptID ??= ctx.currentAttemptID
        }
        if (!attemptID) return
        ctx.runTrace.recordToolExecutionStarted({
          attemptID,
          at: Date.now(),
          monotonicMs: performance.now(),
          toolName: RunObservability.safeToolName(input.tool),
          effect: RunObservability.toolEffect(input.tool),
        })
      })

      const recordToolExecutionCompleted = Effect.fn("SessionProcessor.recordToolExecutionCompleted")(
        function* (input: { toolCallID: string }) {
          const attemptID = toolCallAttemptID(input.toolCallID)
          if (!attemptID) return
          ctx.runTrace.recordToolCompleted({
            attemptID,
            at: Date.now(),
            monotonicMs: performance.now(),
          })
        },
      )

      const recordToolExecutionFailed = Effect.fn("SessionProcessor.recordToolExecutionFailed")(function* (input: {
        toolCallID: string
        error?: unknown
      }) {
        const attemptID = toolCallAttemptID(input.toolCallID)
        if (!attemptID) return
        ctx.runTrace.recordToolFailed({
          attemptID,
          at: Date.now(),
          monotonicMs: performance.now(),
          error: input.error,
        })
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) {
          ;(ctx.pendingToolUpdates[toolCallID] ??= []).push(update)
          return
        }
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const applyPendingToolUpdates = Effect.fn("SessionProcessor.applyPendingToolUpdates")(function* (
        toolCallID: string,
      ) {
        const pending = ctx.pendingToolUpdates[toolCallID]
        if (!pending?.length) return
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        const next = pending.reduce((part, update) => update(part), match.part)
        const part = yield* session.updatePart(next)
        delete ctx.pendingToolUpdates[toolCallID]
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
      })

      const toolStateMetadata = (part: MessageV2.ToolPart) =>
        "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : undefined

      const toolDiagnostics = (part: MessageV2.ToolPart): SessionDiagnostics.Metadata["diagnostics"] | undefined => {
        const diagnostics = toolStateMetadata(part)?.diagnostics
        if (!isRecord(diagnostics)) return undefined
        return diagnostics as SessionDiagnostics.Metadata["diagnostics"]
      }

      const loopRecords = (parentID: MessageV2.Assistant["parentID"]) => {
        if (!parentID) return []
        const out: SessionDiagnostics.ToolCallRecord[] = []
        for (const message of Array.from(MessageV2.stream(ctx.sessionID)).reverse()) {
          if (message.info.role !== "assistant" || message.info.parentID !== parentID) continue
          for (const part of message.parts) {
            // patch parts are skipped so they cannot consume the tool-record path or
            // affect failure-side same-step gating downstream; the success-side gate
            // that previously consumed a mutation epoch was removed for #767.
            if (part.type === "patch") continue
            if (part.type !== "tool") continue
            if (part.state.status !== "completed") continue
            const loop = toolDiagnostics(part)?.loop
            if (!loop?.inputHash) continue
            if (loop.errorFingerprint || loop.loopAction) continue
            out.push({
              sessionID: ctx.sessionID,
              parentID,
              tool: part.tool,
              inputHash: loop.inputHash,
              targetHash: loop.targetHash ?? "",
              outputHash: loop.outputHash,
              metadata: { diagnostics: { loop } },
            } satisfies SessionDiagnostics.ToolCallRecord)
          }
        }
        return out
      }

      // Surface tool parts that represent a loop-relevant failure: real tool errors (carry
      // errorFingerprint) AND synthetic block/stop markers. deriveParentLoopState applies the
      // policy filter (loopAction !== "block"|"stop") on top — keeping this filter broad means
      // we don't silently drop synthetic markers if a future merge accidentally clears
      // errorFingerprint.
      const errorRecords = (parentID: MessageV2.Assistant["parentID"]) => {
        if (!parentID) return []
        return Array.from(MessageV2.stream(ctx.sessionID)).flatMap((message) => {
          if (message.info.role !== "assistant" || message.info.parentID !== parentID) return []
          return message.parts.flatMap((part) => {
            if (part.type !== "tool") return []
            const loop = toolDiagnostics(part)?.loop
            if (!loop) return []
            const isLoopRelevant = !!loop.errorFingerprint || loop.loopAction === "block" || loop.loopAction === "stop"
            if (!isLoopRelevant) return []
            const targetHash = loop.targetHashIsFallback ? undefined : loop.targetHash
            return [
              {
                sessionID: ctx.sessionID,
                parentID,
                tool: part.tool,
                inputHash: loop.inputHash ?? "",
                targetHash,
                errorFingerprint: loop.errorFingerprint ?? "",
                lastInput: loop.loopLastInput,
                lastError: loop.loopLastError,
                metadata: { diagnostics: { loop } },
              } satisfies SessionDiagnostics.ToolErrorRecord,
            ]
          })
        })
      }

      const syntheticBlockSigKeys = (parentID: MessageV2.Assistant["parentID"]): string[] => {
        if (!parentID) return []
        const out: string[] = []
        for (const message of Array.from(MessageV2.stream(ctx.sessionID))) {
          if (message.info.role !== "assistant" || message.info.parentID !== parentID) continue
          for (const part of message.parts) {
            if (part.type !== "tool") continue
            const loop = toolDiagnostics(part)?.loop
            if (loop?.loopAction !== "block") continue
            if (loop.loopSigKey) out.push(loop.loopSigKey)
          }
        }
        return out
      }

      const hasStopped = (parentID: MessageV2.Assistant["parentID"]): boolean => {
        if (!parentID) return false
        for (const message of Array.from(MessageV2.stream(ctx.sessionID))) {
          if (message.info.role !== "assistant" || message.info.parentID !== parentID) continue
          for (const part of message.parts) {
            if (part.type !== "tool") continue
            if (toolDiagnostics(part)?.loop?.loopAction === "stop") return true
          }
        }
        return false
      }

      // Single-pass aggregator. applyLoopGate runs before every tool execution and would otherwise
      // call errorRecords + syntheticBlockSigKeys + hasStopped (three full O(n) scans of the message
      // stream); this helper folds them into one scan.
      const buildLoopContext = (parentID: MessageV2.Assistant["parentID"]) => {
        const errorRecordsOut: SessionDiagnostics.ToolErrorRecord[] = []
        const syntheticBlockSigKeysOut: string[] = []
        let hasStoppedOut = false
        let currentStepIndex: number | undefined
        if (!parentID) {
          return {
            errorRecords: errorRecordsOut,
            syntheticBlockSigKeys: syntheticBlockSigKeysOut,
            hasStopped: hasStoppedOut,
            currentStepIndex,
          }
        }
        for (const message of Array.from(MessageV2.stream(ctx.sessionID)).reverse()) {
          if (message.info.role !== "assistant" || message.info.parentID !== parentID) continue
          let stepIndex = 0
          let sawStepStart = false
          let afterStepFinish = false
          const currentMessage = message.info.id === ctx.assistantMessage.id
          for (const part of message.parts) {
            // patch parts are skipped before currentStepIndex / tool-record processing
            // so failure-side same-step gating semantics are preserved exactly as before.
            // The success-side gate that previously consumed a mutation epoch was removed
            // for #767.
            if (part.type === "patch") continue
            if (part.type === "step-start") {
              sawStepStart = true
              afterStepFinish = false
              stepIndex += 1
              continue
            }
            const activeStepIndex = !sawStepStart || afterStepFinish ? stepIndex + 1 : stepIndex
            if (currentMessage) currentStepIndex = activeStepIndex
            if (part.type === "step-finish") {
              afterStepFinish = true
              continue
            }
            if (part.type !== "tool") continue
            const loop = toolDiagnostics(part)?.loop
            if (!loop) continue
            const observedStepIndex = currentMessage ? activeStepIndex : -1
            const loopWithStep = {
              ...loop,
              stepIndex: loop.stepIndex ?? observedStepIndex,
            }
            if (loop.loopAction === "stop") hasStoppedOut = true
            if (loop.loopAction === "block" && loop.loopSigKey) syntheticBlockSigKeysOut.push(loop.loopSigKey)
            if (loop.errorFingerprint || loop.loopAction === "block" || loop.loopAction === "stop") {
              const targetHash = loop.targetHashIsFallback ? undefined : loop.targetHash
              errorRecordsOut.push({
                sessionID: ctx.sessionID,
                parentID,
                tool: part.tool,
                inputHash: loop.inputHash ?? "",
                targetHash,
                errorFingerprint: loop.errorFingerprint ?? "",
                lastInput: loop.loopLastInput,
                lastError: loop.loopLastError,
                metadata: { diagnostics: { loop: loopWithStep } },
              } satisfies SessionDiagnostics.ToolErrorRecord)
            }
          }
        }
        return {
          errorRecords: errorRecordsOut,
          syntheticBlockSigKeys: syntheticBlockSigKeysOut,
          hasStopped: hasStoppedOut,
          currentStepIndex,
        }
      }

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: MessageV2.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        const diagnostics = toolDiagnostics(match.part)
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: diagnostics
              ? SessionDiagnostics.mergeMetadata(output.metadata, {
                  diagnostics: {
                    ...diagnostics,
                    loop: {
                      ...diagnostics.loop,
                      outputHash: SessionDiagnostics.outputHash(output.output),
                    },
                  },
                })
              : output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return false
        const pending = ctx.pendingLoopActions[toolCallID]
        if (pending) {
          delete ctx.pendingLoopActions[toolCallID]
          const existingMeta = toolStateMetadata(match.part)
          const metadata = SessionDiagnostics.mergeMetadata(existingMeta, {
            diagnostics: {
              loop: {
                loopAction: pending.loopAction,
                loopType: pending.kind,
                loopSigKey: pending.sigKey,
                outcome: pending.outcome,
                loopCompletedCount: pending.completedCount,
                loopCompletedFailures: pending.completedFailures,
                loopOccurrenceCount: pending.nextOccurrenceCount,
                attemptedInput: pending.attemptedInput,
              },
            },
          })
          const end = Date.now()
          const start = "time" in match.part.state ? match.part.state.time.start : end
          yield* session.updatePart({
            ...match.part,
            state: {
              status: "error",
              input: match.part.state.input,
              error: pending.errorMessage,
              metadata,
              time: { start, end },
            },
          })
          if (pending.loopAction === "stop" && pending.renderedText) {
            yield* session.updatePart({
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: ctx.assistantMessage.id,
              type: "text",
              text: pending.renderedText,
              synthetic: true,
            })
            ctx.blocked = true
          }
          yield* settleToolCall(toolCallID)
          return true
        }
        if (match.part.state.status !== "running") {
          yield* settleToolCall(toolCallID)
          return false
        }
        const inflightLoop = toolDiagnostics(match.part)?.loop
        const inputHash = inflightLoop?.inputHash
        const targetHash = inflightLoop?.targetHashIsFallback ? undefined : inflightLoop?.targetHash
        const diagnostics: SessionDiagnostics.Metadata["diagnostics"] | undefined = ctx.assistantMessage.parentID
          ? SessionDiagnostics.observeToolError({
              records: errorRecords(ctx.assistantMessage.parentID),
              sessionID: ctx.sessionID,
              parentID: ctx.assistantMessage.parentID,
              tool: match.part.tool,
              inputHash,
              targetHash,
              originalInput: match.part.state.input,
              error,
            }).record.metadata.diagnostics
          : toolDiagnostics(match.part)
        // Narrow writer wiring (v10 P2 #4): only `ExternalResult.Error`
        // carries a typed `reason` that survives to ToolStateError.reason.
        // Every other thrown/defect intentionally leaves `reason` undefined
        // so the renderer's substring fallback for non-question tool errors
        // continues to fire.
        const reason = error instanceof ExternalResult.Error ? error.reason : undefined
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            ...(reason !== undefined ? { reason } : {}),
            metadata: SessionDiagnostics.mergeMetadata(toolStateMetadata(match.part), {
              diagnostics: {
                ...(diagnostics ?? {}),
                failure: classifyToolFailure({ tool: match.part.tool, error }),
              },
            }),
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof Permission.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent, attemptID: RunObservability.AttemptID) {
        ctx.trace.observeEvent(value)
        const now = Date.now()
        const monotonicMs = performance.now()
        if (RunObservability.isProviderProgressEvent(value)) {
          ctx.runTrace.recordProviderProgress({ attemptID, at: now, monotonicMs })
        }
        if (value.type === "text-start" || value.type === "text-delta") {
          ctx.runTrace.recordVisibleOutput({ attemptID, at: now, monotonicMs, kind: "text" })
        }
        if (value.type === "reasoning-start") {
          ctx.runTrace.recordVisibleOutput({
            attemptID,
            at: now,
            monotonicMs,
            kind: "reasoning",
          })
        }
        if (value.type === "tool-input-start") {
          ctx.runTrace.recordToolInputStarted({
            attemptID,
            at: now,
            monotonicMs,
            providerExecuted: (value as { providerExecuted?: boolean }).providerExecuted,
          })
        }
        if (value.type === "tool-input-end") {
          ctx.runTrace.recordToolInputCompleted({
            attemptID: toolCallAttemptID(value.id, attemptID) ?? attemptID,
            at: now,
            monotonicMs,
          })
        }
        if (value.type === "tool-call") {
          ctx.runTrace.recordToolCallMaterialized({
            attemptID: toolCallAttemptID(value.toolCallId, attemptID) ?? attemptID,
            at: now,
            monotonicMs,
            toolName: RunObservability.safeToolName(value.toolName),
            effect: RunObservability.toolEffect(value.toolName),
          })
        }
        switch (value.type) {
          case "start":
            yield* status.set(ctx.sessionID, { type: "busy" })
            return

          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            const persistedReasoning = yield* session.updatePart(ctx.reasoningMap[value.id])
            const attemptKey = String(attemptID)
            ctx.reasoningPartIDsByAttempt[attemptKey] ??= new Set()
            ctx.reasoningPartIDsByAttempt[attemptKey].add(persistedReasoning.id)
            return

          case "reasoning-delta":
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (!(value.id in ctx.reasoningMap)) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text
            ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePart(ctx.reasoningMap[value.id])
            delete ctx.reasoningMap[value.id]
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            const part = yield* session.updatePart({
              id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: value.toolName,
              callID: value.id,
              state: { status: "pending", input: {}, raw: "" },
              metadata: value.providerExecuted ? { providerExecuted: true } : undefined,
            } satisfies MessageV2.ToolPart)
            ctx.toolcalls[value.id] = {
              done: yield* Deferred.make<void>(),
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
              attemptID,
            }
            yield* applyPendingToolUpdates(value.id)
            return

          case "tool-input-delta":
            return

          case "tool-input-end":
            return

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            const tracked = ctx.toolcalls[value.toolCallId]
            if (tracked) {
              tracked.materialized = true
              tracked.attemptID ??= attemptID
            }
            let running = yield* updateToolCall(value.toolCallId, (match) => ({
              ...match,
              tool: value.toolName,
              state: {
                ...match.state,
                status: "running",
                input: value.input,
                time: { start: Date.now() },
              },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))
            yield* applyPendingToolUpdates(value.toolCallId)
            const refreshed = yield* readToolCall(value.toolCallId)
            if (refreshed) running = refreshed.part
            if (!ctx.assistantMessage.parentID) return
            const info = yield* session.get(ctx.sessionID)
            const observed = SessionDiagnostics.observeToolCall({
              records: loopRecords(ctx.assistantMessage.parentID),
              sessionID: ctx.sessionID,
              parentSessionID: info.parentID,
              parentID: ctx.assistantMessage.parentID,
              tool: value.toolName,
              input: value.input,
              agent: ctx.assistantMessage.agent,
              modelID: ctx.model.id,
              providerID: ctx.model.providerID,
            })
            const withDiagnostics = (part: MessageV2.ToolPart) => ({
              ...part,
              state: {
                ...part.state,
                metadata: SessionDiagnostics.mergeMetadata(toolStateMetadata(part), observed.record.metadata),
              },
            })
            if (running) yield* session.updatePart(withDiagnostics(running))
            else yield* updateToolCall(value.toolCallId, withDiagnostics)
            return
          }

          case "tool-result": {
            yield* completeToolCall(value.toolCallId, value.output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.toolCallId, value.error)
            return
          }

          case "error":
            ctx.trace.recordProviderErrorEvent({
              error: value.error,
              provider: "providerMetadata" in value ? value.providerMetadata : undefined,
              failedAt: Date.now(),
              monotonicMs: performance.now(),
            })
            throw value.error

          case "start-step":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "finish-step": {
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage,
              metadata: value.providerMetadata,
            })
            ctx.trace.finish(value.finishReason, usage.tokens)
            ctx.assistantMessage.finish = value.finishReason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.finishReason,
              snapshot: yield* snapshot.track(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return

          default:
            slog.info("unhandled", { event: value.type, value })
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout(`${TOOL_CLEANUP_TIMEOUT_MS} millis`), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          const interruptionPhase: ToolInterruptionPhase = match.call.executionStarted
            ? "tool_execution"
            : match.call.materialized || part.state.status === "running"
              ? "tool_call_materialized_without_execution"
              : "tool_input_generation"
          // Question tool deserves a clearer post-cancel message: the LLM
          // reads this string as the tool result, and "Tool execution aborted"
          // is ambiguous between "user dismissed your question" and "the run
          // was cancelled before they answered". State only the certain fact
          // (cancelled before answered), don't claim whether the user saw it
          // — they may have. See issue #419.
          const errorText =
            part.tool === "question"
              ? "Question cancelled before the user answered it."
              : TOOL_INTERRUPTION_ERRORS[interruptionPhase]
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: errorText,
              metadata: {
                ...metadata,
                interrupted: true,
                interruption_phase: interruptionPhase,
                tool_execution_started: match.call.executionStarted === true,
              },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
          const attemptID = match.call.attemptID ?? ctx.currentAttemptID
          if (attemptID) {
            if (match.call.executionStarted) {
              ctx.runTrace.recordToolInterrupted({
                attemptID,
                at: end,
                monotonicMs: performance.now(),
              })
            } else {
              ctx.runTrace.recordPendingToolPartInterrupted({
                attemptID,
                at: end,
                monotonicMs: performance.now(),
                interruptionPhase,
                toolExecutionStarted: false,
              })
            }
          }
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        const persistedAssistant = (yield* session.messages({ sessionID: ctx.sessionID })).find(
          (message) => message.info.role === "assistant" && message.info.id === ctx.assistantMessage.id,
        )
        ctx.assistantMessage.diagnostics = {
          ...(persistedAssistant?.info.role === "assistant" ? persistedAssistant.info.diagnostics : {}),
          ...(ctx.assistantMessage.diagnostics ?? {}),
          llm_trace: ctx.trace.finalize({
            completedAt: ctx.assistantMessage.time.completed,
            finishReason: ctx.assistantMessage.finish,
            storedParts: MessageV2.parts(ctx.assistantMessage.id),
            tokens: ctx.assistantMessage.tokens,
            streamError: ctx.streamError,
            aborted,
          }),
          run_observability: ctx.runTrace.finalize({
            completedAt: ctx.assistantMessage.time.completed,
            monotonicMs: performance.now(),
          }),
        }
        yield* session.updateMessage(ctx.assistantMessage)
        yield* turnChange.finalize({ sessionID: ctx.sessionID, messageID: ctx.assistantMessage.id })
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (
        e: unknown,
        attemptID: RunObservability.AttemptID | undefined = ctx.currentAttemptID,
        options?: { recordFailure?: boolean; interruptionMessage?: string },
      ) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        ctx.streamError = true
        if (attemptID && options?.recordFailure !== false) {
          ctx.runTrace.recordTransportFailure({
            attemptID,
            at: Date.now(),
            monotonicMs: performance.now(),
            error: e,
            evidence: ["iterator_error"],
          })
        }

        // Read-then-reset: free_quota path leaves a value here; all other paths
        // leave it undefined. Resetting at entry guards against "previous halt
        // set free_quota → next halt generic" cross-call staling.
        const cls = ctx.terminalClassification
        ctx.terminalClassification = undefined

        if (cls?.kind === "free_quota_exhausted") {
          // Terminal rate-limit path: write blocked status and set ctx.blocked so
          // process() returns "stop". Intentionally does NOT publish
          // Session.Event.Error (would trigger the OS notification toast) and does
          // NOT write ctx.assistantMessage.error (would render the generic error card).
          yield* status.set(ctx.sessionID, { type: "rate_limit_blocked", classification: cls })
          ctx.blocked = true
          return
        }

        const error = parse(e)
        if (options?.interruptionMessage && isRecord(error.data)) {
          error.data = { ...error.data, message: options.interruptionMessage }
        }
        if (MessageV2.ContextOverflowError.isInstance(error)) {
          ctx.needsCompaction = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const recordProcessInterrupt = Effect.fn("SessionProcessor.recordProcessInterrupt")(function* (
        attemptID: RunObservability.AttemptID | undefined,
      ) {
        aborted = true
        const lifecycleAction = currentLifecycleCloseAction(ctx.directory)
        ctx.runTrace.recordScopeClosed({
          at: Date.now(),
          monotonicMs: performance.now(),
          source: "session.processor.onInterrupt",
          reason: "aborted",
          propagationPoint: "session.processor.process.onInterrupt",
          ...(lifecycleAction ? lifecycleCloseActionMeta(lifecycleAction) : {}),
        })
        ctx.trace.recordAbortState({
          provenanceSource: "session.processor.onInterrupt",
          provenanceReason: "aborted",
          provenanceMode: "hard",
          provenanceRecordedAt: Date.now(),
        })
        if (!ctx.assistantMessage.error) {
          yield* halt(new DOMException("Aborted", "AbortError"), attemptID)
        }
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        slog.info("process")
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        let processAttemptID: RunObservability.AttemptID | undefined
        let automaticStreamRetriesUsed = 0
        let safeRetryNoticeWritten = false

        const retryStillAllowed = Effect.fn("SessionProcessor.retryStillAllowed")(function* (stage: string) {
          const lifecycleAction = currentLifecycleCloseAction(ctx.directory)
          if (!lifecycleAction) return { allowed: true as const }
          ctx.runTrace.recordScopeClosed({
            at: Date.now(),
            monotonicMs: performance.now(),
            source: `session.processor.safe_recovery.${stage}`,
            reason: "lifecycle_close_before_auto_retry",
            propagationPoint: "session.processor.safe_recovery",
            ...lifecycleCloseActionMeta(lifecycleAction),
          })
          return {
            allowed: false as const,
            interruptionMessage: LOCAL_LIFECYCLE_CLOSE_INTERRUPTION_MESSAGE,
          }
        })

        const retrySignalFor = (error: unknown) => {
          const phase = watchdogPhase(error)
          if (phase) {
            return {
              retryable: true,
              message: "Connection timed out",
              watchdog: { phase },
            }
          }
          const parsed = parse(error)
          const classification = SessionRetry.classifyRetry(parsed)
          if (!classification) return { retryable: false }
          if (SessionRetry.retryAction(classification) === "stop") {
            ctx.terminalClassification = classification
            return { retryable: false }
          }
          return { retryable: true, message: classification.raw }
        }

        const removeReasoningForAttempt = Effect.fn("SessionProcessor.removeReasoningForAttempt")(function* (
          attemptID: RunObservability.AttemptID,
        ) {
          const partIDs = ctx.reasoningPartIDsByAttempt[String(attemptID)]
          if (!partIDs?.size) return
          for (const partID of partIDs) {
            yield* session.removePart({
              sessionID: ctx.sessionID,
              messageID: ctx.assistantMessage.id,
              partID,
            })
          }
          for (const [id, part] of Object.entries(ctx.reasoningMap)) {
            if (partIDs.has(part.id)) delete ctx.reasoningMap[id]
          }
          delete ctx.reasoningPartIDsByAttempt[String(attemptID)]
        })

        const writeSafeRetryFailedNotice = Effect.fn("SessionProcessor.writeSafeRetryFailedNotice")(function* (
          attemptID: RunObservability.AttemptID,
        ) {
          ctx.streamError = true
          yield* removeReasoningForAttempt(attemptID)
          yield* session.updatePart({
            id: PartID.ascending(),
            sessionID: ctx.sessionID,
            messageID: ctx.assistantMessage.id,
            type: "notice",
            kind: "safe_retry_failed",
            time: { created: Date.now() },
          } satisfies MessageV2.NoticePart)
          yield* status.set(ctx.sessionID, { type: "idle" })
          safeRetryNoticeWritten = true
        })

        const safeRecoveryStep = yield* Schedule.toStepWithMetadata(
          SessionRetry.safeRecoveryPolicy({
            set: (info) =>
              status.set(ctx.sessionID, {
                type: "retry",
                attempt: info.attempt,
                message: info.message,
                next: info.next,
                presentation: info.presentation,
                reason: info.reason,
              }),
          }),
        )

        const runAttempt = Effect.fn("SessionProcessor.runAttempt")(function* () {
          ctx.currentText = undefined
          ctx.reasoningMap = {}
          ctx.attemptCount++
          const activeTools = LLM.resolveTools(streamInput)
          const boundarySnapshot = RunObservability.sideEffectBoundarySnapshot(activeTools)
          const sessionTimeouts = attemptStreamTimeouts(
            streamInput.model,
            automaticStreamRetriesUsed,
            streamInput,
            boundarySnapshot,
          )
          const attempt = ctx.runTrace.beginAttempt({
            attemptIndex: ctx.attemptCount,
            at: Date.now(),
            monotonicMs: performance.now(),
            connectTimeoutMs: sessionTimeouts.connectTimeoutMs ?? streamInput.connectTimeoutMs,
          })
          ctx.currentAttemptID = attempt.attemptID
          processAttemptID = attempt.attemptID
          ctx.runTrace.recordSideEffectBoundarySnapshot({
            attemptID: attempt.attemptID,
            at: Date.now(),
            monotonicMs: performance.now(),
            snapshot: boundarySnapshot,
          })
          let stream: Stream.Stream<LLM.Event, unknown>
          try {
            stream = llm.stream({
              ...ProviderTransform.streamTimeouts(streamInput.model),
              ...streamInput,
              ...sessionTimeouts,
              tools: activeTools,
              trace: ctx.trace,
            })
          } catch (error) {
            ctx.runTrace.recordSetupFailure({ at: Date.now(), monotonicMs: performance.now(), error })
            throw error
          }

          yield* stream.pipe(
            Stream.tap((event) => handleEvent(event, attempt.attemptID)),
            // Stop draining the stream as soon as the loop gate fires a synthetic stop
            // (ctx.blocked) so any trailing model text after the synthetic stop tool-error
            // is dropped — the turn ends with the rendered Chinese summary alone.
            Stream.takeUntil(() => ctx.needsCompaction || ctx.blocked),
            Stream.runDrain,
          )
        })

        return yield* Effect.gen(function* () {
          while (true) {
            const result = yield* runAttempt().pipe(
              Effect.onInterrupt(() => recordProcessInterrupt(processAttemptID)),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) => Effect.fail(Cause.squash(cause)),
              ),
              Effect.catch((error: unknown) => Effect.succeed({ ok: false as const, error })),
            )
            if (result === undefined) break
            if (result.ok !== false) break

            const attemptID = processAttemptID
            const retrySignal = retrySignalFor(result.error)
            const decision = ctx.runTrace.recordAttemptFailureAndDeriveRecovery({
              attemptID,
              at: Date.now(),
              monotonicMs: performance.now(),
              error: result.error,
              evidence: retrySignal.watchdog ? ["watchdog_fired", "iterator_error"] : ["iterator_error"],
              watchdog: retrySignal.watchdog,
              retryable: retrySignal.retryable,
            })
            const retryDecision = buildModelRetryDecision({
              technicalRetryability: retrySignal.retryable
                ? { retryable: true, message: retrySignal.message }
                : {
                    retryable: false,
                    reason: ctx.terminalClassification ? "terminal_classification" : "not_retryable",
                  },
              safetyGateDecision: decision,
              modelStreamAttempt: ctx.attemptCount,
              safeRecoveryAttempt: automaticStreamRetriesUsed,
              timeoutPolicy: retryTimeoutPolicyFor(
                streamInput.model,
                automaticStreamRetriesUsed,
                streamInput,
                RunObservability.sideEffectBoundarySnapshot(LLM.resolveTools(streamInput)),
              ),
            })
            ctx.runTrace.recordRecoveryDecision({
              attemptID,
              at: Date.now(),
              monotonicMs: performance.now(),
              technical_retryable: retryDecision.technicalRetryability.retryable,
              technical_retry_blocked_reason: retryDecision.technicalRetryability.retryable
                ? undefined
                : retryDecision.technicalRetryability.reason,
              safety_gate_decision: retryDecision.safetyGateDecision,
              recovery_mode: retryDecision.recoveryMode,
              blocked_reason: retryDecision.blockedReason,
              attempt_kind: retryDecision.attemptKind,
              model_stream_attempt: retryDecision.modelStreamAttempt,
              safe_recovery_attempt: retryDecision.safeRecoveryAttempt,
              timeout_policy: retryDecision.timeoutPolicy,
              presentation: retryDecision.presentation,
            })

            if (attemptID && retryDecision.canRetry && retryDecision.recoveryMode === "replay") {
              const beforeRetry = yield* retryStillAllowed("before_backoff")
              if (beforeRetry.allowed) {
                automaticStreamRetriesUsed += 1
                yield* removeReasoningForAttempt(attemptID)
                const safeRecoveryScheduled = yield* safeRecoveryStep(undefined).pipe(
                  Effect.as(true),
                  Effect.catchCause(() => Effect.succeed(false)),
                  Effect.onInterrupt(() => recordProcessInterrupt(attemptID)),
                )
                if (!safeRecoveryScheduled) {
                  yield* writeSafeRetryFailedNotice(attemptID)
                  break
                }
                const afterRetry = yield* retryStillAllowed("after_backoff")
                if (afterRetry.allowed) {
                  ctx.runTrace.recordAutoRetryAttempted({
                    attemptID,
                    at: Date.now(),
                    monotonicMs: performance.now(),
                  })
                  continue
                }
                yield* halt(result.error, attemptID, {
                  recordFailure: false,
                  interruptionMessage: afterRetry.interruptionMessage,
                })
                break
              }
              yield* halt(result.error, attemptID, {
                recordFailure: false,
                interruptionMessage: beforeRetry.interruptionMessage,
              })
              break
            }

            if (
              attemptID &&
              retryDecision.recoveryMode === "auto_replay_blocked" &&
              retryDecision.presentation === "safe_recovery_failed"
            ) {
              yield* writeSafeRetryFailedNotice(attemptID)
              break
            }

            yield* halt(result.error, attemptID, {
              recordFailure: false,
              interruptionMessage: recoveryInterruptionMessage(decision),
            })
            break
          }

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error || safeRetryNoticeWritten) return "stop"
          return "continue"
        }).pipe(Effect.ensuring(cleanup()))
      })

      const recordSyntheticBlock = Effect.fn("SessionProcessor.recordSyntheticBlock")(function* (input: {
        toolCallId: string
        tool: string
        sigKey: string
        kind: SessionDiagnostics.SignatureKind
        outcome: SessionDiagnostics.LoopOutcome
        completedCount: number
        completedFailures?: number
        nextOccurrenceCount: number
        attemptedInput?: unknown
        errorMessage: string
      }) {
        ctx.pendingLoopActions[input.toolCallId] = {
          loopAction: "block",
          tool: input.tool,
          sigKey: input.sigKey,
          kind: input.kind,
          outcome: input.outcome,
          completedCount: input.completedCount,
          completedFailures: input.completedFailures,
          nextOccurrenceCount: input.nextOccurrenceCount,
          attemptedInput: input.attemptedInput,
          errorMessage: input.errorMessage,
        }
        const match = yield* readToolCall(input.toolCallId)
        if (!match) return
        delete ctx.pendingLoopActions[input.toolCallId]
        // Idempotence guard: if the model emits multiple parallel tool calls of the same
        // sigKey within one assistant step, applyLoopGate can decide block for several of
        // them before any has persisted. Re-check existing block sigKeys here so we record
        // at most one synthetic block per sigKey per parentID. This still has a residual
        // race window (two parallel writers can both pass this check), but closes the most
        // likely path. Full fix would need a per-parent Effect.Mutex; deferred as the
        // residual race only produces extra diagnostic parts, not behavioral drift.
        const parentID = ctx.assistantMessage.parentID
        if (parentID) {
          const existing = syntheticBlockSigKeys(parentID)
          if (existing.includes(input.sigKey)) {
            // Still write a terminal `error` state for THIS part — without the loop marker,
            // so deriveParentLoopState only counts one synthetic block per sigKey. Skipping
            // the write would leave the part stuck in pending/running forever after settle.
            const dupEnd = Date.now()
            const dupStart = "time" in match.part.state ? match.part.state.time.start : dupEnd
            yield* session.updatePart({
              ...match.part,
              state: {
                status: "error",
                input: match.part.state.input,
                error: input.errorMessage,
                metadata: toolStateMetadata(match.part),
                time: { start: dupStart, end: dupEnd },
              },
            })
            yield* settleToolCall(input.toolCallId)
            return
          }
        }
        const existingMeta = toolStateMetadata(match.part)
        const merged = SessionDiagnostics.mergeMetadata(existingMeta, {
          diagnostics: {
            loop: {
              loopAction: "block",
              loopType: input.kind,
              loopSigKey: input.sigKey,
              outcome: input.outcome,
              loopCompletedCount: input.completedCount,
              loopCompletedFailures: input.completedFailures,
              loopOccurrenceCount: input.nextOccurrenceCount,
              attemptedInput: input.attemptedInput,
            },
          },
        })
        const end = Date.now()
        const startTime = "time" in match.part.state ? match.part.state.time.start : end
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: input.errorMessage,
            metadata: merged,
            time: { start: startTime, end },
          },
        })
        yield* settleToolCall(input.toolCallId)
      })

      const recordSyntheticStop = Effect.fn("SessionProcessor.recordSyntheticStop")(function* (input: {
        toolCallId: string
        tool: string
        sigKey: string
        kind: SessionDiagnostics.SignatureKind
        outcome: SessionDiagnostics.LoopOutcome
        completedCount: number
        completedFailures?: number
        nextOccurrenceCount: number
        attemptedInput?: unknown
        renderedText: string
        toolErrorMessage: string
      }) {
        ctx.pendingLoopActions[input.toolCallId] = {
          loopAction: "stop",
          tool: input.tool,
          sigKey: input.sigKey,
          kind: input.kind,
          outcome: input.outcome,
          completedCount: input.completedCount,
          completedFailures: input.completedFailures,
          nextOccurrenceCount: input.nextOccurrenceCount,
          attemptedInput: input.attemptedInput,
          errorMessage: input.toolErrorMessage,
          renderedText: input.renderedText,
        }
        const match = yield* readToolCall(input.toolCallId)
        if (!match) return
        delete ctx.pendingLoopActions[input.toolCallId]
        // Idempotence guard (see recordSyntheticBlock for the full rationale): re-check
        // hasStopped here. The duplicate-stop case writes two Chinese summaries which is
        // visible UX noise; this guard closes the most common parallel-call window.
        const parentID = ctx.assistantMessage.parentID
        if (parentID && hasStopped(parentID)) {
          // Same reason as the block-side guard: write a terminal `error` state without the
          // loop marker (no duplicate stop summary, no second TextPart) so the part can't be
          // left forever pending/running after settle.
          const dupEnd = Date.now()
          const dupStart = "time" in match.part.state ? match.part.state.time.start : dupEnd
          yield* session.updatePart({
            ...match.part,
            state: {
              status: "error",
              input: match.part.state.input,
              error: input.toolErrorMessage,
              metadata: toolStateMetadata(match.part),
              time: { start: dupStart, end: dupEnd },
            },
          })
          yield* settleToolCall(input.toolCallId)
          return
        }
        const existingMeta = toolStateMetadata(match.part)
        const merged = SessionDiagnostics.mergeMetadata(existingMeta, {
          diagnostics: {
            loop: {
              loopAction: "stop",
              loopType: input.kind,
              loopSigKey: input.sigKey,
              outcome: input.outcome,
              loopCompletedCount: input.completedCount,
              loopCompletedFailures: input.completedFailures,
              loopOccurrenceCount: input.nextOccurrenceCount,
              attemptedInput: input.attemptedInput,
            },
          },
        })
        const stopEnd = Date.now()
        const stopStart = "time" in match.part.state ? match.part.state.time.start : stopEnd
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: input.toolErrorMessage,
            metadata: merged,
            time: { start: stopStart, end: stopEnd },
          },
        })
        const textPart: MessageV2.TextPart = {
          id: PartID.ascending(),
          sessionID: ctx.sessionID,
          messageID: ctx.assistantMessage.id,
          type: "text",
          text: input.renderedText,
          synthetic: true,
        }
        yield* session.updatePart(textPart)
        yield* settleToolCall(input.toolCallId)
        ctx.blocked = true
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        recordToolExecutionStarted,
        recordToolExecutionCompleted,
        recordToolExecutionFailed,
        process,
        errorRecords,
        syntheticBlockSigKeys,
        hasStopped,
        buildLoopContext,
        recordSyntheticBlock,
        recordSyntheticStop,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(TurnChange.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
