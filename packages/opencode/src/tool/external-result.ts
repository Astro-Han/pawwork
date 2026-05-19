import { Schema } from "effect"

export namespace ExternalResult {
  // Typed error raised when an external-result Deferred is aborted (turn
  // cancelled via ctx.abort) or shutdown (server / session destroyed).
  // The runner narrows the Tool wrapper's catchAll so this error survives
  // as a typed failure rather than being defectified; the processor's
  // failToolCall reads `.reason` and persists it as ToolStateError.reason.
  export class Error extends Schema.TaggedErrorClass<Error>()("ExternalResultError", {
    reason: Schema.Union([Schema.Literal("aborted"), Schema.Literal("shutdown")]),
  }) {
    override get message() {
      return `External result was ${this.reason}.`
    }
  }
}
