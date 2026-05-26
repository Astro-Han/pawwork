import {
  createRecorder as createRunRecorder,
  isProviderProgressEvent as isProviderProgressStreamEvent,
  makeRunID as makeRunIdentifier,
  summaryKeyFor as makeSummaryKey,
} from "./recorder"
import {
  allowsBeforeProgressRetry as allowsBeforeProgressBoundaryRetry,
  sideEffectBoundarySnapshot as deriveSideEffectBoundarySnapshot,
} from "./boundary"
import { safeToolName as makeSafeToolName, toolEffect as classifyToolEffect } from "./sanitize"
import { SCHEMA_VERSION as VERSION, RunID as RunIDSchema, AttemptID as AttemptIDSchema } from "./types"
import * as Types from "./types"

export namespace RunObservability {
  export const SCHEMA_VERSION = VERSION
  export const RunID = { ...RunIDSchema, make: (value: string) => RunIDSchema.parse(value) }
  export const AttemptID = { ...AttemptIDSchema, make: (value: string) => AttemptIDSchema.parse(value) }
  export const createRecorder = createRunRecorder
  export const makeRunID = makeRunIdentifier
  export const summaryKeyFor = makeSummaryKey
  export const isProviderProgressEvent = isProviderProgressStreamEvent
  export const safeToolName = makeSafeToolName
  export const toolEffect = classifyToolEffect
  export const boundaryAllowsBeforeProgressRetry = allowsBeforeProgressBoundaryRetry
  export const sideEffectBoundarySnapshot = deriveSideEffectBoundarySnapshot

  export type RunID = Types.RunID
  export type AttemptID = Types.AttemptID
  export type Summary = Types.Summary
  export type Recorder = Types.Recorder
  export type RecorderInput = Types.RecorderInput
  export type SideEffectBoundarySnapshot = Types.SideEffectBoundarySnapshot
  export type Classification = Types.Classification
  export type SummaryKey = Types.SummaryKey
}
