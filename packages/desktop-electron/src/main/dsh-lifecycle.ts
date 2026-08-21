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
  productTimeoutMs?: number
}

const DEFAULT_PRODUCT_TIMEOUT_MS = 30_000

export class DshLifecycle {
  #state: DshLifecycleState = { phase: "stopped" }
  #run: DshRun | undefined
  #stopping: Promise<void> | undefined
  #productTimeout: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: DshLifecycleOptions) {}

  get state() {
    return this.#state
  }

  get url() {
    return this.#state.phase === "loading" || this.#state.phase === "ready" ? this.#state.url : undefined
  }

  start() {
    if (["starting", "loading", "ready", "stopping"].includes(this.#state.phase)) return
    this.#publish({ phase: "starting" })

    let run: DshRun
    try {
      run = this.options.launch()
    } catch (error) {
      this.#publish({ phase: "failed", reason: "startup", error })
      return
    }
    this.#run = run

    void run.ready.then(
      (url) => {
        if (this.#run !== run) return
        this.#publish({ phase: "loading", url })
        const timeoutMs = this.options.productTimeoutMs ?? DEFAULT_PRODUCT_TIMEOUT_MS
        this.#productTimeout = setTimeout(() => {
          void this.#fail(run, "startup", new Error(`DSH product did not become ready within ${timeoutMs}ms`))
        }, timeoutMs)
      },
      (error) => void this.#fail(run, "startup", error),
    )
    void run.exited.then((code) => {
      const reason = this.#state.phase === "ready" ? "crash" : "startup"
      void this.#fail(run, reason, new Error(`DSH exited ${describeExit(code)}`))
    })
  }

  productReady(frameUrl: string) {
    if (this.#state.phase !== "loading") return
    try {
      if (new URL(frameUrl).origin !== new URL(this.#state.url).origin) return
    } catch {
      return
    }
    this.#clearProductTimeout()
    this.#publish({ phase: "ready", url: this.#state.url })
  }

  stop() {
    if (this.#stopping !== undefined) return this.#stopping
    this.#clearProductTimeout()
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
    this.#clearProductTimeout()
    await run.stop()
    if (this.#state.phase === "stopping" || this.#state.phase === "stopped") return
    this.#publish({ phase: "failed", reason, error })
  }

  #clearProductTimeout() {
    if (this.#productTimeout === undefined) return
    clearTimeout(this.#productTimeout)
    this.#productTimeout = undefined
  }

  #publish(state: DshLifecycleState) {
    this.#state = state
    this.options.onChange(state)
  }
}
