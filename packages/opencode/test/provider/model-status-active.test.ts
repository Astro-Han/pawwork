import { test, expect } from "bun:test"
import { Model as ConfigProviderModel } from "../../src/config/provider"
import { ModelsDev } from "../../src/provider"

// Regression for #26592: the runtime emits status "active" (provider.ts), so both the
// config-load schema and the models.dev catalog schema must accept it instead of
// crashing config load on a model that declares status: "active".

test("config provider Model schema accepts status: active", () => {
  const result = ConfigProviderModel.zod.safeParse({ status: "active" })
  expect(result.success).toBe(true)
})

test("models.dev Model schema accepts status: active", () => {
  const result = ModelsDev.Model.safeParse({
    id: "test-model",
    name: "Test Model",
    release_date: "2026-01-01",
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: false,
    limit: { context: 128000, output: 8192 },
    status: "active",
  })
  expect(result.success).toBe(true)
})
