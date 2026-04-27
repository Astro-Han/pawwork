import { SessionDiagnostics } from "./diagnostics"

export namespace LoopRenderer {
  export type RenderInput = {
    tool: string
    state: SessionDiagnostics.SignatureState
    locale?: string
  }

  export function render(input: RenderInput): string {
    const { tool, state, locale } = input
    const errorLine = firstErrorLine(state.lastError)
    const scrubbedError = errorLine ? scrubErrorText(errorLine) : undefined
    const truncatedError = scrubbedError ? SessionDiagnostics.truncateForRenderer(scrubbedError) : undefined
    const isZh = (locale ?? "").toLowerCase().startsWith("zh")

    if (tool === "webfetch") {
      const rawURL = extractURL(state.lastInput)
      const cleanedURL = rawURL ? stripQueryAndFragment(rawURL) : undefined
      const truncatedURL = cleanedURL ? SessionDiagnostics.truncateForRenderer(cleanedURL) : undefined
      if (state.kind === "input") {
        if (isZh) {
          return truncatedURL
            ? `我重复调用了相同的请求 ${state.completedFailures} 次没成功，已停止。请求：webfetch ${truncatedURL}`
            : `我重复调用了相同的请求 ${state.completedFailures} 次没成功，已停止。`
        }
        return truncatedURL
          ? `I made the same request ${state.completedFailures} times without success and stopped. Request: webfetch ${truncatedURL}`
          : `I made the same request ${state.completedFailures} times without success and stopped.`
      }
      if (isZh) {
        if (truncatedURL && truncatedError)
          return `我重复抓取同一个目标 ${state.completedFailures} 次都失败，已停止。目标：${truncatedURL} 错误：${truncatedError}`
        if (truncatedURL)
          return `我重复抓取同一个目标 ${state.completedFailures} 次都失败，已停止。目标：${truncatedURL}`
        if (truncatedError)
          return `我重复抓取同一个目标 ${state.completedFailures} 次都失败，已停止。错误：${truncatedError}`
        return `我重复抓取同一个目标 ${state.completedFailures} 次都失败，已停止。`
      }
      if (truncatedURL && truncatedError)
        return `I failed to fetch the same target ${state.completedFailures} times and stopped. Target: ${truncatedURL} Error: ${truncatedError}`
      if (truncatedURL)
        return `I failed to fetch the same target ${state.completedFailures} times and stopped. Target: ${truncatedURL}`
      if (truncatedError)
        return `I failed to fetch the same target ${state.completedFailures} times and stopped. Error: ${truncatedError}`
      return `I failed to fetch the same target ${state.completedFailures} times and stopped.`
    }

    if (state.kind === "target") {
      if (isZh) {
        return truncatedError
          ? `我重复在同一个目标上失败了 ${state.completedFailures} 次，已停止。工具：${tool} 错误：${truncatedError}`
          : `我重复在同一个目标上失败了 ${state.completedFailures} 次，已停止。工具：${tool}`
      }
      return truncatedError
        ? `I failed against the same target ${state.completedFailures} times and stopped. Tool: ${tool} Error: ${truncatedError}`
        : `I failed against the same target ${state.completedFailures} times and stopped. Tool: ${tool}`
    }

    if (isZh) {
      return truncatedError
        ? `我重复调用了 ${tool} ${state.completedFailures} 次都失败，已停止。最近一次错误：${truncatedError}`
        : `我重复调用了 ${tool} ${state.completedFailures} 次都失败，已停止。`
    }
    return truncatedError
      ? `I called ${tool} ${state.completedFailures} times without success and stopped. Last error: ${truncatedError}`
      : `I called ${tool} ${state.completedFailures} times without success and stopped.`
  }

  function extractURL(value: unknown): string | undefined {
    if (typeof value === "string") return value
    if (!value || typeof value !== "object") return undefined
    const r = value as Record<string, unknown>
    if (typeof r.url === "string") return r.url
    if (typeof r.href === "string") return r.href
    return undefined
  }

  function stripQueryAndFragment(url: string): string {
    try {
      const u = new URL(url)
      return `${u.protocol}//${u.host}${u.pathname}`
    } catch {
      const q = url.indexOf("?")
      const f = url.indexOf("#")
      const cuts = [q, f].filter((i) => i >= 0)
      if (!cuts.length) return url
      return url.slice(0, Math.min(...cuts))
    }
  }

  // Strip query strings and fragments from any URLs embedded in free text (error messages,
  // stack traces, etc.). Tokens often live in `?token=...` or `#access_token=...`. The `i`
  // flag covers uppercase scheme variants like `HTTPS://`.
  function scrubURLsInText(text: string): string {
    return text.replace(/(https?:\/\/[^\s,;)]+)/gi, (match) => stripQueryAndFragment(match))
  }

  // Multi-pass scrub for tool error text. Tool errors echo URLs with tokens, fully-qualified
  // file paths, quoted user input, and Bearer/Basic auth headers. Mask each class so the
  // synthetic stop summary does not become a leak vector. Path detection uses a negative
  // lookbehind so `Error:at /tmp/x` and `failed at '/home/alice/key'` get scrubbed too — not
  // only paths preceded by start-of-line or whitespace. Path char class allows spaces
  // (real paths: `/Users/alice/My Documents/...`) and stops at structural delimiters
  // (quote, comma, semicolon, colon, paren/bracket, newline) — over-scrub of trailing
  // descriptive text is preferred to under-scrub leaving secrets visible.
  function scrubErrorText(text: string): string {
    return scrubURLsInText(text)
      .replace(/(?:Bearer|Basic|token|api[_-]?key)[\s:=]+[^\s'"`,;)]+/gi, "<token>")
      .replace(/['"`][^'"`]*['"`]/g, "<quoted>")
      .replace(/\b[A-Za-z]:\\[^'"`,;:)\]\n]+/g, "<path>")
      // Forward-slash Windows paths (`C:/Users/...`) — JS path normalization on Windows can
      // produce these, and the general path regex below excludes `:` as preceding char to
      // avoid stripping URL paths, so drive-letter forward-slash paths need their own pass.
      .replace(/\b[A-Za-z]:\/[^'"`,;:)\]\n]+/g, "<path>")
      // Relative paths starting with `./` or `../`. Without this pass the absolute-path
      // regex below only catches the `/...` suffix and leaves the leading dots visible.
      .replace(/(?<![\w.])\.\.?\/[^'"`,;:)\]\n]+/g, "<path>")
      .replace(/(?<![\w/:])\/[^'"`,;:)\]\n]+/g, "<path>")
  }

  function firstErrorLine(error: unknown): string | undefined {
    const line = SessionDiagnostics.firstLine(error)
    return line === "" ? undefined : line
  }
}
