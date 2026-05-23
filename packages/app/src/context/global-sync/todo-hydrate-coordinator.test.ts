import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createTodoHydrateCoordinator } from "./todo-hydrate-coordinator"

describe("createTodoHydrateCoordinator", () => {
  test("tracks sessions and returns local eviction requests", () => {
    createRoot((dispose) => {
      const coordinator = createTodoHydrateCoordinator({ sessionLimit: 2, directoryLimit: 2 })

      expect(coordinator.touch("dir-a", "ses_1")).toEqual([])
      expect(coordinator.touch("dir-a", "ses_2")).toEqual([])
      expect(coordinator.touch("dir-a", "ses_3")).toEqual([{ directory: "dir-a", sessionIDs: ["ses_1"] }])
      expect(coordinator.has("dir-a", "ses_1")).toBe(false)
      expect(coordinator.has("dir-a", "ses_3")).toBe(true)

      dispose()
    })
  })

  test("keeps scheduled hydrates pending until the current token completes", () => {
    createRoot((dispose) => {
      const coordinator = createTodoHydrateCoordinator()

      coordinator.touch("dir-a", "ses_1")
      coordinator.scheduleHydrate("dir-a", "ses_1", "visible")
      expect(coordinator.isPending("dir-a", "ses_1")).toBe(true)

      const token = coordinator.beginHydrate("dir-a", "ses_1", "visible")
      expect(coordinator.isCurrent(token)).toBe(true)

      coordinator.completeHydrate(token, {
        cacheAccepted: true,
        recoveryValidated: false,
        liveWritesReopened: true,
      })
      expect(coordinator.isPending("dir-a", "ses_1")).toBe(false)

      dispose()
    })
  })

  test("invalidates stale hydrate tokens", () => {
    createRoot((dispose) => {
      const coordinator = createTodoHydrateCoordinator()

      coordinator.touch("dir-a", "ses_1")
      const stale = coordinator.beginHydrate("dir-a", "ses_1", "visible")
      const current = coordinator.beginHydrate("dir-a", "ses_1", "recovery")

      expect(coordinator.isCurrent(stale)).toBe(false)
      expect(coordinator.isCurrent(current)).toBe(true)

      dispose()
    })
  })

  test("cancels scheduled hydrate without evicting the tracked session", () => {
    createRoot((dispose) => {
      const coordinator = createTodoHydrateCoordinator()

      coordinator.touch("dir-a", "ses_1")
      coordinator.scheduleHydrate("dir-a", "ses_1", "visible")
      coordinator.cancelHydrate("dir-a", "ses_1")

      expect(coordinator.isPending("dir-a", "ses_1")).toBe(false)
      expect(coordinator.has("dir-a", "ses_1")).toBe(true)

      dispose()
    })
  })

  test("records recovery validation against the token target epoch", () => {
    createRoot((dispose) => {
      const coordinator = createTodoHydrateCoordinator()

      coordinator.touch("dir-a", "ses_1")
      const epoch1 = coordinator.markGlobalRecovery()
      const token = coordinator.beginHydrate("dir-a", "ses_1", "recovery")
      const epoch2 = coordinator.markGlobalRecovery()

      coordinator.completeHydrate(token, {
        cacheAccepted: false,
        recoveryValidated: true,
        liveWritesReopened: true,
      })

      expect(epoch1).toBe(1)
      expect(epoch2).toBe(2)
      expect(coordinator.validatedRecoveryEpoch("dir-a", "ses_1")).toBe(1)
      expect(coordinator.recoveryEpoch()).toBe(2)

      dispose()
    })
  })

  test("authoritative invalidation closes live writes until a current hydrate reopens them", () => {
    createRoot((dispose) => {
      const coordinator = createTodoHydrateCoordinator()

      coordinator.touch("dir-a", "ses_1")
      const token = coordinator.beginHydrate("dir-a", "ses_1", "visible")
      coordinator.invalidateSession("ses_1")

      expect(coordinator.isCurrent(token)).toBe(false)
      expect(coordinator.canAcceptLiveTodo("dir-a", "ses_1")).toBe(false)
      expect(coordinator.isAuthoritativelyInvalidated("ses_1")).toBe(true)

      coordinator.touch("dir-a", "ses_1")
      const reopened = coordinator.beginHydrate("dir-a", "ses_1", "visible")
      coordinator.completeHydrate(reopened, {
        cacheAccepted: true,
        recoveryValidated: false,
        liveWritesReopened: true,
      })

      expect(coordinator.canAcceptLiveTodo("dir-a", "ses_1")).toBe(true)
      expect(coordinator.isAuthoritativelyInvalidated("ses_1")).toBe(false)

      dispose()
    })
  })

  test("authoritative invalidation removes tracked sessions from every directory", () => {
    createRoot((dispose) => {
      const coordinator = createTodoHydrateCoordinator()

      coordinator.touch("dir-a", "ses_1")
      coordinator.touch("dir-b", "ses_1")
      coordinator.scheduleHydrate("dir-a", "ses_1", "visible")
      coordinator.scheduleHydrate("dir-b", "ses_1", "busy")

      coordinator.invalidateSession("ses_1")

      expect(coordinator.has("dir-a", "ses_1")).toBe(false)
      expect(coordinator.has("dir-b", "ses_1")).toBe(false)
      expect(coordinator.isPending("dir-a", "ses_1")).toBe(false)
      expect(coordinator.isPending("dir-b", "ses_1")).toBe(false)
      expect(coordinator.isAuthoritativelyInvalidated("ses_1")).toBe(true)

      dispose()
    })
  })
})
