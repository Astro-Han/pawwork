import { NamedError } from "@opencode-ai/util/error"
import { errorFormat } from "@/util/error"

interface ErrorLike {
  name?: string
  _tag?: string
  message?: string
  data?: Record<string, any>
}

function hasName(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as ErrorLike).name === name
}

function isTaggedError(error: unknown, tag: string): boolean {
  return (
    typeof error === "object" && error !== null && "_tag" in error && (error as Record<string, unknown>)._tag === tag
  )
}

export function FormatError(input: unknown) {
  if (isTaggedError(input, "CliError")) {
    const data = input as ErrorLike & { exitCode?: number }
    if (data.exitCode != null) process.exitCode = data.exitCode
    return data.message ?? ""
  }

  // MCPFailed: { name: string }
  if (hasName(input, "MCPFailed")) {
    return `MCP server "${(input as ErrorLike).data?.name}" failed. Note, opencode does not support MCP authentication yet.`
  }

  // AccountServiceError, AccountTransportError: TaggedErrorClass
  if (isTaggedError(input, "AccountServiceError") || isTaggedError(input, "AccountTransportError")) {
    return (input as ErrorLike).message ?? ""
  }

  // ProviderModelNotFoundError: { providerID: string, modelID: string, suggestions?: string[] }
  if (hasName(input, "ProviderModelNotFoundError")) {
    const data = (input as ErrorLike).data
    const suggestions: string[] = Array.isArray(data?.suggestions) ? data.suggestions : []
    return [
      `Model not found: ${data?.providerID}/${data?.modelID}`,
      ...(suggestions.length ? ["Did you mean: " + suggestions.join(", ")] : []),
      `Try: \`opencode models\` to list available models`,
      `Or check your config (pawwork.json) provider/model names`,
    ].join("\n")
  }

  // ProviderInitError: { providerID: string }
  if (hasName(input, "ProviderInitError")) {
    return `Failed to initialize provider "${(input as ErrorLike).data?.providerID}". Check credentials and configuration.`
  }

  // ConfigJsonError: { path: string, message?: string }
  if (hasName(input, "ConfigJsonError")) {
    const data = (input as ErrorLike).data
    return `Config file at ${data?.path} is not valid JSON(C)` + (data?.message ? `: ${data.message}` : "")
  }

  // ConfigDirectoryTypoError: { dir: string, path: string, suggestion: string }
  if (hasName(input, "ConfigDirectoryTypoError")) {
    const data = (input as ErrorLike).data
    return `Directory "${data?.dir}" in ${data?.path} is not valid. Rename the directory to "${data?.suggestion}" or remove it. This is a common typo.`
  }

  // ConfigFrontmatterError: { message: string }
  if (hasName(input, "ConfigFrontmatterError")) {
    return (input as ErrorLike).data?.message ?? ""
  }

  // ConfigRemoteAuthError: { url: string, remote: string, message: string }
  if (hasName(input, "ConfigRemoteAuthError")) {
    const data = (input as ErrorLike).data
    return [
      `Failed to load remote config from ${data?.remote}: ${data?.message}.`,
      "Authentication may be missing or expired.",
      `Run \`opencode auth login ${data?.url}\` to re-authenticate.`,
    ].join("\n")
  }

  // ConfigInvalidError: { path?: string, message?: string, issues?: Array<{ message: string, path: string[] }> }
  if (hasName(input, "ConfigInvalidError")) {
    const data = (input as ErrorLike).data
    const path = data?.path
    const message = data?.message
    const issues: Array<{ message: string; path: string[] }> = Array.isArray(data?.issues) ? data.issues : []
    return [
      `Configuration is invalid${path && path !== "config" ? ` at ${path}` : ""}` + (message ? `: ${message}` : ""),
      ...issues.map((issue) => "↳ " + issue.message + " " + issue.path.join(".")),
    ].join("\n")
  }

  // UICancelledError: void (no data)
  if (hasName(input, "UICancelledError")) {
    return ""
  }
}

export function FormatUnknownError(input: unknown): string {
  return errorFormat(input)
}
