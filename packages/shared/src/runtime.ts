export namespace Runtime {
  export function isPawWork() {
    return process.env.PAWWORK_RUNTIME_NAMESPACE?.startsWith("pawwork") ?? false
  }

  export function appName() {
    return isPawWork() ? "pawwork" : "opencode"
  }
}
