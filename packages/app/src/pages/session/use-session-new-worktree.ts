import { createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"

export function createSessionNewWorktree(input: {
  directory: () => string
  projectWorktree: () => string | undefined
}) {
  const [store, setStore] = createStore({
    value: "main",
  })

  const selected = createMemo(() => {
    if (store.value === "create") return "create"
    const worktree = input.projectWorktree()
    if (worktree && input.directory() !== worktree) return input.directory()
    return "main"
  })

  const reset = () => setStore("value", "main")

  createEffect(
    on(
      input.directory,
      (dir) => {
        if (!dir) return
        reset()
      },
      { defer: true },
    ),
  )

  return { selected, reset }
}
