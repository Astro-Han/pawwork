import { Effect, Schema } from "effect"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { ExternalResult } from "./external-result"
import { Agent } from "@/agent/agent"

interface Metadata {
  [key: string]: any
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
  // Registers an external-result Deferred for this tool call and suspends
  // the tool's execute until either:
  //   - POST /session/:sessionID/tool/respond resolves with the user's
  //     payload (returns `{kind: "submitted", value}`)
  //   - the same route resolves with a dismiss (returns `{kind: "dismissed"}`)
  //   - ctx.abort fires (typed failure `ExternalResultError({reason: "aborted"})`)
  //   - the session is destroyed via onSessionDestroyed (typed failure
  //     `ExternalResultError({reason: "shutdown"})`)
  // The `inputSnapshot` is captured at registration so the route can run
  // shape-specific validation against the same input the LLM emitted, even
  // if the tool's input field is mutated later.
  // Optional `decoder`: tool-owned validator that runs at the route before
  // the Deferred is resolved. The route handler is intentionally generic
  // and only invokes decoders supplied here — it never imports tool-
  // specific semantics. Decoder failure returns 422 to the client and
  // leaves the entry pending so the client can retry with a corrected
  // payload. Tools without a decoder forward any payload through (back-
  // compat for non-question external-result tools that may exist later).
  // Returns `unknown` because the resolved value's shape is tool-specific;
  // the calling tool narrows by convention (e.g. the question tool knows
  // the discriminated-union shape its server route produces).
  externalResult?(input: {
    inputSnapshot: unknown
    decoder?: ResponseDecoder
  }): Effect.Effect<ExternalResultOutcome, ExternalResultError>
}

// Re-exported types so consumers can refer to the surface shape without
// importing the underlying module. The runtime values live in
// `./external-result.ts`.
import type { ExternalResult as ExternalResultModule } from "./external-result"
export type ExternalResultError = ExternalResultModule.Error
export type ExternalResultOutcome = { kind: "submitted"; value: unknown } | { kind: "dismissed" }
export type ResponseDecoder = ExternalResultModule.ResponseDecoder
export type DecodeResult = ExternalResultModule.DecodeResult

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  description: string
  parameters: Parameters
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>, unknown>
  formatValidationError?(error: unknown): string
  // When true, this tool's `execute` invokes `ctx.externalResult` and must
  // wait for an external POST to resolve before returning. The runner /
  // renderer can read this declaration (via `info.externalResult` once the
  // tool is materialised) to scope behaviour that should only apply to
  // external-result tools — e.g. the "preparing..." placeholder while
  // the registry registers the Deferred. Plain tools without this flag
  // are unaffected.
  externalResult?: boolean
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = Omit<Def<Parameters, M>, "id">

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          const decoded = yield* decode(args).pipe(
            Effect.mapError((error) =>
              toolInfo.formatValidationError
                ? new Error(toolInfo.formatValidationError(error), { cause: error })
                : new Error(
                    `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`,
                    { cause: error },
                  ),
            ),
          )
          const result = yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx)
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(
          // Narrow catch (replaces blanket .orDie). ExternalResultError
          // (turn abort / session shutdown) survives as a typed failure so
          // the processor's failToolCall can read .reason and persist it as
          // ToolStateError.reason. All other typed errors continue to
          // defectify, matching the prior .orDie behavior so existing tool
          // error paths are unchanged.
          Effect.catch((err: unknown) =>
            err instanceof ExternalResult.Error ? Effect.fail(err) : Effect.die(err),
          ),
          Effect.withSpan("Tool.execute", { attributes: attrs }),
        )
      }
      return toolInfo
    })
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}
