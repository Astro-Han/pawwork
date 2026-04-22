export namespace Runtime {
  export function isPawWork() {
    return process.env.PAWWORK_RUNTIME_NAMESPACE === "pawwork"
  }

  export function appName() {
    return isPawWork() ? "pawwork" : "opencode"
  }
}
