import { expect, test } from "bun:test"
import { shouldShowPawworkSidebarNav } from "./pawwork-sidebar-visibility"

test("keeps sidebar navigation chrome visible for the workspace picker with no sessions", () => {
  expect(
    shouldShowPawworkSidebarNav({
      canShowMore: false,
      capReached: false,
      hasSessions: false,
      hasWorkspacePicker: true,
    }),
  ).toBe(true)
})

test("hides the empty navigation chrome when nothing inside it is available", () => {
  expect(
    shouldShowPawworkSidebarNav({
      canShowMore: false,
      capReached: false,
      hasSessions: false,
      hasWorkspacePicker: false,
    }),
  ).toBe(false)
})
