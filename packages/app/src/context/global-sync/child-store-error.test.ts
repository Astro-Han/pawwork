import { describe, expect, test } from "bun:test"
import { catchError, createRoot, getOwner } from "solid-js"
import { createStore } from "solid-js/store"
import {
  ChildStoreError,
  createPersistedChildCache,
  validateChildStoreDirectory,
} from "./child-store-error"

const translate = (key: string) => {
  if (key === "error.childStore.persistedCacheCreateFailed") return "Failed to create persisted cache"
  return key
}

describe("child store diagnostics", () => {
  test("rejects invalid workspace directories before persisted cache setup", () => {
    for (const directory of [undefined, ""]) {
      expect(() => validateChildStoreDirectory(directory)).toThrow("Invalid workspace directory for child store")

      try {
        validateChildStoreDirectory(directory)
      } catch (error) {
        expect(error).toBeInstanceOf(ChildStoreError)
        expect((error as ChildStoreError).context).toEqual({
          kind: "workspace",
          directory,
        })
        continue
      }

      throw new Error("expected invalid directory to throw")
    }
  })

  test("describes unserializable invalid directories without masking validation errors", () => {
    const circular: { self?: unknown } = {}
    circular.self = circular

    for (const directory of [1n, circular]) {
      try {
        validateChildStoreDirectory(directory)
      } catch (error) {
        expect(error).toBeInstanceOf(ChildStoreError)
        expect((error as ChildStoreError).message).toContain("<unserializable>")
        expect((error as ChildStoreError).context.directory).toBe(directory)
        continue
      }

      throw new Error("expected invalid directory to throw")
    }
  })

  test("preserves the original persisted cache setup cause and context", () => {
    const cause = new TypeError("storage init failed")
    const target = {
      storage: "pawwork.workspace.-tmp-project.abc123.dat",
      key: "workspace:vcs",
      legacy: ["vcs.v1"],
    }

    createRoot((dispose) => {
      const owner = getOwner()
      if (!owner) throw new Error("owner required")

      try {
        createPersistedChildCache({
          owner,
          directory: "/tmp/project",
          kind: "vcs",
          messageKey: "error.childStore.persistedCacheCreateFailed",
          target,
          store: createStore({ value: undefined as string | undefined }),
          translate,
          persist: () => {
            throw cause
          },
        })
      } catch (error) {
        dispose()
        expect(error).toBeInstanceOf(ChildStoreError)
        expect(error).toHaveProperty("cause", cause)
        expect((error as ChildStoreError).message).toContain("Failed to create persisted cache")
        expect((error as ChildStoreError).message).toContain("cache=vcs")
        expect((error as ChildStoreError).message).toContain("storage=pawwork.workspace.-tmp-project.abc123.dat")
        expect((error as ChildStoreError).message).toContain("key=workspace:vcs")
        expect((error as ChildStoreError).context).toEqual({
          kind: "vcs",
          directory: "/tmp/project",
          storage: "pawwork.workspace.-tmp-project.abc123.dat",
          key: "workspace:vcs",
        })
        return
      }

      dispose()
      throw new Error("expected persisted cache setup to throw")
    })
  })

  test("preserves cause when owner error boundary handles persisted setup failure", () => {
    const cause = new TypeError("storage init failed")
    const handled: unknown[] = []

    catchError(
      () => {
        createRoot((dispose) => {
          const owner = getOwner()
          if (!owner) throw new Error("owner required")

          try {
            createPersistedChildCache({
              owner,
              directory: "/tmp/project",
              kind: "vcs",
              messageKey: "error.childStore.persistedCacheCreateFailed",
              target: {
                storage: "pawwork.workspace.-tmp-project.abc123.dat",
                key: "workspace:vcs",
              },
              store: createStore({ value: undefined as string | undefined }),
              translate,
              persist: () => {
                throw cause
              },
            })
          } catch (error) {
            dispose()
            expect(error).toBeInstanceOf(ChildStoreError)
            expect(error).toHaveProperty("cause", cause)
            return
          }

          dispose()
          throw new Error("expected persisted cache setup to throw")
        })
      },
      (error) => {
        handled.push(error)
      },
    )

    expect(handled).toEqual([cause])
  })
})
