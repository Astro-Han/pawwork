import { createEffect, createMemo, createSignal, on } from "solid-js"

export function createSessionNewWorktree(input: {
  directory: () => string
  projectWorktree: () => string | undefined
}) {
  const [value, setValue] = createSignal("main")

  const selected = createMemo(() => {
    if (value() === "create") return "create"
    const worktree = input.projectWorktree()
    if (worktree && input.directory() !== worktree) return input.directory()
    return "main"
  })

  const reset = () => setValue("main")

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
