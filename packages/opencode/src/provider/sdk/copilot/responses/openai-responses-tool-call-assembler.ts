import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"

export type ResponsesFunctionCallAdded = {
  outputIndex: number
  itemId: string
  callId: string
  toolName: string
  arguments: string
}

export type ResponsesFunctionCallArgumentsDelta = {
  outputIndex: number
  itemId: string
  delta: string
}

export type ResponsesFunctionCallArgumentsDone = {
  outputIndex: number
  itemId: string
  toolName: string
  arguments: string
}

export type ResponsesFunctionCallDone = {
  outputIndex: number
  itemId: string
  callId: string
  toolName: string
  arguments: string
}

type ResponsesToolCallState = {
  outputIndex: number
  itemId: string
  callId: string
  toolName: string
  argumentDeltas: string[]
  addedArguments: string
  doneArguments?: string
  materialized: boolean
}

export class ResponsesToolCallAssembler {
  private readonly statesByItemId = new Map<string, ResponsesToolCallState>()
  private readonly itemIdByOutputIndex = new Map<number, string>()

  onFunctionCallAdded(input: ResponsesFunctionCallAdded): LanguageModelV3StreamPart[] {
    const previousItemId = this.itemIdByOutputIndex.get(input.outputIndex)
    if (previousItemId) {
      this.statesByItemId.delete(previousItemId)
    }

    const state: ResponsesToolCallState = {
      outputIndex: input.outputIndex,
      itemId: input.itemId,
      callId: input.callId,
      toolName: input.toolName,
      argumentDeltas: [],
      addedArguments: input.arguments,
      materialized: false,
    }
    this.statesByItemId.set(input.itemId, state)
    this.itemIdByOutputIndex.set(input.outputIndex, input.itemId)

    return [{ type: "tool-input-start", id: input.callId, toolName: input.toolName }]
  }

  onFunctionCallArgumentsDelta(input: ResponsesFunctionCallArgumentsDelta): LanguageModelV3StreamPart[] {
    const state = this.lookup(input.itemId, input.outputIndex)
    if (!state.ok) return [this.error(state.message)]
    if (state.value.materialized) return []

    state.value.argumentDeltas.push(input.delta)
    return [{ type: "tool-input-delta", id: state.value.callId, delta: input.delta }]
  }

  onFunctionCallArgumentsDone(input: ResponsesFunctionCallArgumentsDone): LanguageModelV3StreamPart[] {
    const state = this.lookup(input.itemId, input.outputIndex)
    if (!state.ok) return [this.error(state.message)]
    if (state.value.toolName !== input.toolName) {
      const message = `OpenAI Responses function call name mismatch for item ${input.itemId}: started ${state.value.toolName}, completed ${input.toolName}`
      this.remove(state.value)
      return [this.error(message)]
    }
    if (state.value.materialized) return []

    state.value.doneArguments = input.arguments
    return this.materialize(state.value, input.arguments)
  }

  onFunctionCallDone(input: ResponsesFunctionCallDone): LanguageModelV3StreamPart[] {
    const state = this.lookup(input.itemId, input.outputIndex)
    if (!state.ok) return [this.error(state.message)]
    if (state.value.callId !== input.callId) {
      const message = `OpenAI Responses function call id mismatch for item ${input.itemId}: started ${state.value.callId}, completed ${input.callId}`
      this.remove(state.value)
      return [this.error(message)]
    }
    if (state.value.toolName !== input.toolName) {
      const message = `OpenAI Responses function call name mismatch for item ${input.itemId}: started ${state.value.toolName}, completed ${input.toolName}`
      this.remove(state.value)
      return [this.error(message)]
    }
    if (state.value.materialized) {
      this.remove(state.value)
      return []
    }

    return this.materialize(state.value, input.arguments, { removeAfterMaterialize: true })
  }

  failUnmaterialized(reason: string): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = []
    for (const state of this.statesByItemId.values()) {
      if (!state.materialized) {
        parts.push(
          this.error(
            `OpenAI Responses function call input did not complete before ${reason}: ${state.toolName} (${state.callId})`,
          ),
        )
      }
    }
    this.statesByItemId.clear()
    this.itemIdByOutputIndex.clear()
    return parts
  }

  private lookup(
    itemId: string,
    outputIndex: number,
  ): { ok: true; value: ResponsesToolCallState } | { ok: false; message: string } {
    const state = this.statesByItemId.get(itemId)
    if (!state) {
      return {
        ok: false,
        message: `OpenAI Responses function call state was missing for item ${itemId} at output index ${outputIndex}`,
      }
    }
    if (state.outputIndex !== outputIndex) {
      return {
        ok: false,
        message: `OpenAI Responses function call output index mismatch for item ${itemId}: started ${state.outputIndex}, received ${outputIndex}`,
      }
    }
    return { ok: true, value: state }
  }

  private materialize(
    state: ResponsesToolCallState,
    input: string,
    options: { removeAfterMaterialize?: boolean } = {},
  ): LanguageModelV3StreamPart[] {
    state.materialized = true
    if (options.removeAfterMaterialize) this.remove(state)
    return [
      { type: "tool-input-end", id: state.callId },
      {
        type: "tool-call",
        toolCallId: state.callId,
        toolName: state.toolName,
        input,
        providerMetadata: { openai: { itemId: state.itemId } },
      },
    ]
  }

  private remove(state: ResponsesToolCallState) {
    this.statesByItemId.delete(state.itemId)
    if (this.itemIdByOutputIndex.get(state.outputIndex) === state.itemId) {
      this.itemIdByOutputIndex.delete(state.outputIndex)
    }
  }

  private error(message: string): LanguageModelV3StreamPart {
    return { type: "error", error: new Error(message) }
  }
}
