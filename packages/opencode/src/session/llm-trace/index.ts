import {
  createRecorder as createTraceRecorder,
  requestSummary as summarizeRequest,
  storedPartCounts as countStoredParts,
} from "./recorder"
import { SCHEMA_VERSION as VERSION } from "./types"
import * as Types from "./types"
import { classifyBoundary as classify, safeProviderCorrelation as safeCorrelation } from "./stream-diagnostics"

export namespace LLMTrace {
  export const SCHEMA_VERSION = VERSION
  export const Summary = Types.Summary
  export const createRecorder = createTraceRecorder
  export const requestSummary = summarizeRequest
  export const storedPartCounts = countStoredParts
  export const classifyBoundary = classify
  export const safeProviderCorrelation = safeCorrelation

  export type RequestSummary = Types.RequestSummary
  export type StreamEvents = Types.StreamEvents
  export type StoredParts = Types.StoredParts
  export type Tokens = Types.Tokens
  export type Flags = Types.Flags
  export type StreamDiagnostics = Types.StreamDiagnostics
  export type Summary = Types.Summary
  export type RequestSummaryInput = Types.RequestSummaryInput
  export type RecorderInput = Types.RecorderInput
  export type FinalizeInput = Types.FinalizeInput
  export type Recorder = Types.Recorder
}
