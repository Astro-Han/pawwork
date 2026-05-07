import { describe, expect, test } from "bun:test"
import { icons } from "../../src/components/icon"

describe("icon registry agent rename (#128)", () => {
  test("agent key exists in icon registry", () => {
    expect(Object.keys(icons)).toContain("agent")
  })

  test("legacy task key does not exist in icon registry", () => {
    expect(Object.keys(icons)).not.toContain("task")
  })

  test("agent svg content is non-empty", () => {
    expect((icons as Record<string, string>).agent).toMatch(/<g[\s>]/)
  })
})

describe("icon registry slice-05 additions (#440)", () => {
  test("circle icon exists for pending todo", () => {
    expect(Object.keys(icons)).toContain("circle")
  })

  test("diff-unified icon exists for unified diff toggle", () => {
    expect(Object.keys(icons)).toContain("diff-unified")
  })

  test("diff-split icon exists for split diff toggle", () => {
    expect(Object.keys(icons)).toContain("diff-split")
  })

  test("circle-check still exists for completed todo", () => {
    expect(Object.keys(icons)).toContain("circle-check")
  })

  test("warning exists for error icon in TextField", () => {
    expect(Object.keys(icons)).toContain("warning")
    expect(Object.keys(icons)).not.toContain("alert-triangle")
  })
})
