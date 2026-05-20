import { describe, expect, test } from "bun:test"
import { inheritMetadata } from "../../src/session/inherit-metadata"

describe("inheritMetadata", () => {
  test("propagates commandTemplate from source", () => {
    const out = inheritMetadata({ metadata: { commandTemplate: true } }, { id: "x", url: "data:..." })
    expect((out.metadata as Record<string, unknown>).commandTemplate).toBe(true)
  })

  test("source wins over derived false", () => {
    const out = inheritMetadata(
      { metadata: { commandTemplate: true } },
      { id: "x", metadata: { commandTemplate: false, extra: 1 } },
    )
    const meta = out.metadata as Record<string, unknown>
    expect(meta.commandTemplate).toBe(true)
    expect(meta.extra).toBe(1)
  })

  test("no-op when source has no metadata", () => {
    const out = inheritMetadata({}, { id: "x", metadata: { extra: 1 } })
    const meta = out.metadata as Record<string, unknown>
    expect(meta.commandTemplate).toBeUndefined()
    expect(meta.extra).toBe(1)
  })

  test("preserves derived fields not in source", () => {
    const out = inheritMetadata(
      { metadata: { commandTemplate: true } },
      { id: "x", url: "data:...", filename: "x.png", metadata: { foo: "bar" } },
    )
    expect(out.id).toBe("x")
    expect(out.filename).toBe("x.png")
    const meta = out.metadata as Record<string, unknown>
    expect(meta.foo).toBe("bar")
    expect(meta.commandTemplate).toBe(true)
  })
})
