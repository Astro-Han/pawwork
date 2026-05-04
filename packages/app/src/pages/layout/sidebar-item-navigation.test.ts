import { describe, expect, test } from "bun:test"
import {
  defaultNewSessionHref,
  defaultSessionHref,
  openShellLinkWithOwner,
  shouldUseShellOwnerForLink,
  type ShellLinkClick,
} from "./sidebar-item-navigation"

const click = (overrides: Partial<ShellLinkClick> = {}): ShellLinkClick => ({
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
    expect(defaultNewSessionHref("repo-slug")).toBe("/repo-slug/session")
  })

  test("routes ordinary left-clicks through the shell owner", () => {
    expect(shouldUseShellOwnerForLink(click())).toBe(true)
  })

  test("opens sidebar links through the shell owner after preventing default navigation", () => {
    const calls: string[] = []
    const handled = openShellLinkWithOwner(
      {
        ...click(),
        preventDefault: () => calls.push("preventDefault"),
      },
      () => calls.push("open"),
    )

    expect(handled).toBe(true)
    expect(calls).toEqual(["preventDefault", "open"])
  })

  test("keeps modified or non-left clicks on the anchor default path", () => {
    expect(shouldUseShellOwnerForLink(click({ metaKey: true }))).toBe(false)
    expect(shouldUseShellOwnerForLink(click({ ctrlKey: true }))).toBe(false)
    expect(shouldUseShellOwnerForLink(click({ shiftKey: true }))).toBe(false)
    expect(shouldUseShellOwnerForLink(click({ altKey: true }))).toBe(false)
    expect(shouldUseShellOwnerForLink(click({ button: 1 }))).toBe(false)
    expect(shouldUseShellOwnerForLink(click({ defaultPrevented: true }))).toBe(false)
  })

  test("does not call the shell owner for modified clicks", () => {
    const calls: string[] = []
    const handled = openShellLinkWithOwner(
      {
        ...click({ metaKey: true }),
        preventDefault: () => calls.push("preventDefault"),
      },
      () => calls.push("open"),
    )

    expect(handled).toBe(false)
    expect(calls).toEqual([])
  })
})
