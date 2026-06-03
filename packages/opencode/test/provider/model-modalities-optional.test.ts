import { test, expect } from "bun:test"
import { Model as ConfigProviderModel } from "../../src/config/provider"

// Regression for #29268: a model may declare only one modality direction. The config
// schema must not require both input and output (consumers read modalities?.input/
// .output ?? false and degrade gracefully), so config load should not crash.

test("config provider Model schema accepts modalities with only input", () => {
  const result = ConfigProviderModel.zod.safeParse({ modalities: { input: ["text", "image"] } })
  expect(result.success).toBe(true)
})

test("config provider Model schema accepts modalities with only output", () => {
  const result = ConfigProviderModel.zod.safeParse({ modalities: { output: ["text"] } })
  expect(result.success).toBe(true)
})
