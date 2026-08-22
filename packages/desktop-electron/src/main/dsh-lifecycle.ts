import { describeExit, type DshRun } from "./dsh-sidecar"

export type DshFailureReason = "startup" | "crash"

export type DshLifecycleState =
  | { phase: "stopped" }
  | { phase: "starting" }
  | { phase: "loading"; url: string }
  | { phase: "ready"; url: string }
  | { phase: "stopping" }
  | { phase: "failed"; reason: DshFailureReason; error: unknown }

type DshTerminalState = Extract<DshLifecycleState, { phase: "stopped" | "failed" }>

type DshLifecycleOptions = {
  launch(): DshRun
  onChange(state: DshLifecycleState): void
}

const PRODUCT_TIMEOUT_MS = 30_000

export class DshLifecycle {
  #state: DshLifecycleState = { phase: "stopped" }
  #run: DshRun | undefined
  #stopping: { promise: Promise<void>; terminal: DshTerminalState } | undefined
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
    if (this.#state.phase !== "starting") return

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
        this.#productTimeout = setTimeout(() => {
          void this.#fail(run, "startup", new Error(`DSH product did not become ready within ${PRODUCT_TIMEOUT_MS}ms`))
        }, PRODUCT_TIMEOUT_MS)
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
    if (this.#stopping !== undefined) {
      this.#stopping.terminal = { phase: "stopped" }
      return this.#stopping.promise
    }
    return this.#finish(this.#run, { phase: "stopped" })
  }

  #fail(run: DshRun, reason: DshFailureReason, error: unknown) {
    if (this.#run !== run) return
    return this.#finish(run, { phase: "failed", reason, error })
  }

  #finish(run: DshRun | undefined, terminal: DshTerminalState) {
    this.#run = undefined
    this.#clearProductTimeout()
    const stopping = { promise: Promise.resolve(), terminal }
    stopping.promise = Promise.resolve()
      .then(() => run?.stop())
      .finally(() => {
        if (this.#stopping === stopping) this.#stopping = undefined
        this.#publish(stopping.terminal)
      })
    this.#stopping = stopping
    this.#publish({ phase: "stopping" })
    return stopping.promise
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
