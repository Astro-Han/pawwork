import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { OtelTracer, aiSdkTracer } from "@opencode-ai/core/effect/observability"

// Regression for the AI-SDK telemetry export gap: session.llm / agent.generate
// used to hardcode tracer=undefined, so AI-SDK spans fell back to the no-op
// global tracer (NodeSdk never registers a global TracerProvider) and never
// exported. They now resolve aiSdkTracer, which must return the OTel tracer when
// one is registered in the Effect context and undefined otherwise.
describe("aiSdkTracer", () => {
  test("returns undefined when no OTel tracer is registered in context", async () => {
    const result = await Effect.runPromise(aiSdkTracer)
    expect(result).toBeUndefined()
  })

  test("returns the registered OTel tracer so AI-SDK spans can export", async () => {
    const fakeTracer = { startSpan() {}, startActiveSpan() {} }
    const result = await Effect.runPromise(
      aiSdkTracer.pipe(Effect.provideService(OtelTracer, fakeTracer as never)),
    )
    expect(result).toBe(fakeTracer as never)
  })
})
