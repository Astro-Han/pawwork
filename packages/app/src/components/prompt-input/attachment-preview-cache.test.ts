import { beforeEach, describe, expect, test } from "bun:test"
import { cachedPreview, loadPreviewCached, _previewCacheTesting } from "./attachment-preview-cache"

describe("attachment preview cache", () => {
  beforeEach(() => {
    _previewCacheTesting.reset()
  })

  test("concurrent loads for the same path share one loader call", async () => {
    let calls = 0
    const loader = async () => {
      calls += 1
      return "data:image/png;base64,AAA"
    }
    const [a, b] = await Promise.all([
      loadPreviewCached("/x/shot.png", "image/png", loader),
      loadPreviewCached("/x/shot.png", "image/png", loader),
    ])
    expect(calls).toBe(1)
    expect(a).toBe("data:image/png;base64,AAA")
    expect(b).toBe("data:image/png;base64,AAA")
  })

  test("resolved previews are cached: no second loader call, synchronous read works", async () => {
    let calls = 0
    const loader = async () => {
      calls += 1
      return "data:image/png;base64,BBB"
    }
    await loadPreviewCached("/x/shot.png", "image/png", loader)
    expect(cachedPreview("/x/shot.png", "image/png")).toBe("data:image/png;base64,BBB")
    await loadPreviewCached("/x/shot.png", "image/png", loader)
    expect(calls).toBe(1)
  })

  test("cache key includes mime: same path with different mime loads separately", async () => {
    const loader = async (_path: string, mime: string) => `data:${mime};base64,X`
    await loadPreviewCached("/x/file", "image/png", loader)
    expect(cachedPreview("/x/file", "image/jpeg")).toBeUndefined()
  })

  test("a rejecting loader caches null and never re-fires", async () => {
    let calls = 0
    const loader = async () => {
      calls += 1
      throw new Error("io error")
    }
    expect(await loadPreviewCached("/x/broken.png", "image/png", loader)).toBeNull()
    expect(cachedPreview("/x/broken.png", "image/png")).toBeNull()
    expect(await loadPreviewCached("/x/broken.png", "image/png", loader)).toBeNull()
    expect(calls).toBe(1)
  })

  test("evicts the least recently used entry beyond the capacity", async () => {
    const loader = async (path: string) => `data:image/png;base64,${path}`
    for (let i = 0; i < 32; i++) {
      await loadPreviewCached(`/x/${i}.png`, "image/png", loader)
    }
    // Touch the oldest entry so it survives the next insert.
    expect(cachedPreview("/x/0.png", "image/png")).toBe("data:image/png;base64,/x/0.png")
    await loadPreviewCached("/x/32.png", "image/png", loader)
    expect(cachedPreview("/x/0.png", "image/png")).toBeDefined()
    expect(cachedPreview("/x/1.png", "image/png")).toBeUndefined()
  })
})
