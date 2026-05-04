import { describe, expect, test } from "bun:test"
import { defaultSessionHref, shouldOpenSessionWithShell, type SidebarSessionClick } from "./sidebar-item-navigation"

const click = (overrides: Partial<SidebarSessionClick> = {}): SidebarSessionClick => ({
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
})

describe("sidebar item navigation", () => {
  test("builds the fallback href for normal browser navigation", () => {
    expect(defaultSessionHref("repo-slug", { id: "ses_123" })).toBe("/repo-slug/session/ses_123")
  })

  test("routes ordinary left-clicks through the shell owner", () => {
    expect(shouldOpenSessionWithShell(click())).toBe(true)
  })

  test("keeps modified or non-left clicks on the anchor default path", () => {
    expect(shouldOpenSessionWithShell(click({ metaKey: true }))).toBe(false)
    expect(shouldOpenSessionWithShell(click({ ctrlKey: true }))).toBe(false)
    expect(shouldOpenSessionWithShell(click({ shiftKey: true }))).toBe(false)
    expect(shouldOpenSessionWithShell(click({ altKey: true }))).toBe(false)
    expect(shouldOpenSessionWithShell(click({ button: 1 }))).toBe(false)
    expect(shouldOpenSessionWithShell(click({ defaultPrevented: true }))).toBe(false)
  })
})
