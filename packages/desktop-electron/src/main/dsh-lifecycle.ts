import { describeExit, type DshRun } from "./dsh-sidecar"

export type DshFailureReason = "startup" | "crash"

export type DshLifecycleState =
  | { phase: "stopped" }
  | { phase: "starting" }
  | { phase: "loading"; url: string }
  | { phase: "ready"; url: string }
  | { phase: "stopping" }
  | { phase: "failed"; reason: DshFailureReason; error: unknown }

type DshLifecycleOptions = {
  launch(): DshRun
  onChange(state: DshLifecycleState): void
}

export class DshLifecycle {
  #state: DshLifecycleState = { phase: "stopped" }
  #run: DshRun | undefined
  #stopping: Promise<void> | undefined

  constructor(private readonly options: DshLifecycleOptions) {}

  get state() {
    return this.#state
  }

  get url() {
    return this.#state.phase === "loading" || this.#state.phase === "ready" ? this.#state.url : undefined
  }

  get isReady() {
    return this.#state.phase === "ready"
  }

  start() {
    if (["starting", "loading", "ready", "stopping"].includes(this.#state.phase)) return false
    this.#publish({ phase: "starting" })

    let run: DshRun
    try {
      run = this.options.launch()
    } catch (error) {
      this.#publish({ phase: "failed", reason: "startup", error })
      return true
    }
    this.#run = run

    void run.ready.then(
      (url) => {
        if (this.#run !== run) return
        this.#publish({ phase: "loading", url })
      },
      (error) => void this.#fail(run, "startup", error),
    )
    void run.exited.then((code) => {
      const reason = this.#state.phase === "ready" ? "crash" : "startup"
      void this.#fail(run, reason, new Error(`DSH exited ${describeExit(code)}`))
    })
    return true
  }

  productReady(frameUrl: string) {
    if (this.#state.phase !== "loading") return false
    try {
      if (new URL(frameUrl).origin !== new URL(this.#state.url).origin) return false
    } catch {
      return false
    }
    this.#publish({ phase: "ready", url: this.#state.url })
    return true
  }

  stop() {
    if (this.#stopping !== undefined) return this.#stopping
    const run = this.#run
    this.#run = undefined
    this.#publish({ phase: "stopping" })
    this.#stopping = Promise.resolve(run?.stop()).finally(() => {
      this.#publish({ phase: "stopped" })
      this.#stopping = undefined
    })
    return this.#stopping
  }

  async #fail(run: DshRun, reason: DshFailureReason, error: unknown) {
    if (this.#run !== run) return
    this.#run = undefined
    await run.stop()
    if (this.#state.phase === "stopping" || this.#state.phase === "stopped") return
    this.#publish({ phase: "failed", reason, error })
  }

  #publish(state: DshLifecycleState) {
    this.#state = state
    this.options.onChange(state)
  }
}
