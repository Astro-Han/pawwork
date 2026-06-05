import { describe, expect, test } from "bun:test"
import { projectGroupHeaderPresentation } from "./pawwork-sidebar-project-group-header-presentation"

describe("projectGroupHeaderPresentation", () => {
  test("keeps project groups folder-shaped and manageable", () => {
    expect(projectGroupHeaderPresentation({ collapsed: true })).toEqual({
      icon: "folder",
      canManage: true,
    })
    expect(projectGroupHeaderPresentation({ collapsed: false })).toEqual({
      icon: "folder-open",
      canManage: true,
    })
  })

  test("renders direct-start groups as chat-shaped and not project-manageable", () => {
    expect(projectGroupHeaderPresentation({ kind: "direct-start", collapsed: false })).toEqual({
      icon: "bubble-5",
      canManage: false,
    })
    expect(projectGroupHeaderPresentation({ kind: "direct-start", collapsed: true })).toEqual({
      icon: "bubble-5",
      canManage: false,
    })
  })
})
