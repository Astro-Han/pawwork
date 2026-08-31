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
  // Fired once per start when the runtime is up but the product UI has not
  // reported in yet. Informational, like the sidecar's own slow signal: a
  // window that has to load the whole product plus its plugins can outlast any
  // deadline worth guessing, and the guess is not worth an unusable app.
  onSlowProduct?(): void
}

const PRODUCT_SLOW_AFTER_MS = 30_000

export class DshLifecycle {
  #state: DshLifecycleState = { phase: "stopped" }
  #run: DshRun | undefined
  #stopping: { promise: Promise<void>; terminal: DshTerminalState } | undefined
  #productSlowTimer: ReturnType<typeof setTimeout> | undefined

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
        this.#productSlowTimer = setTimeout(() => {
          if (this.#run !== run) return
          this.options.onSlowProduct?.()
        }, PRODUCT_SLOW_AFTER_MS)
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
    this.#clearProductSlowTimer()
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
    this.#clearProductSlowTimer()
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

  #clearProductSlowTimer() {
    if (this.#productSlowTimer === undefined) return
    clearTimeout(this.#productSlowTimer)
    this.#productSlowTimer = undefined
  }

  #publish(state: DshLifecycleState) {
    this.#state = state
    this.options.onChange(state)
  }
}
