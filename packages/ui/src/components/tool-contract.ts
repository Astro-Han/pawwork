export const TOOL_TODOWRITE = "todowrite"
export const TOOL_WEBFETCH = "webfetch"
export const TOOL_WEBSEARCH = "websearch"
export const TOOL_QUESTION = "question"
export const TOOL_AGENT_LEGACY = "task"
export const TOOL_AGENT = "agent"

// Embedded-browser tools (#1186). Grouped here so the UI's icon/title casing and
// the contract test stay pinned to the opencode tool ids in one place.
export const TOOL_BROWSER_NAVIGATE = "browser_navigate"
export const TOOL_BROWSER_SCREENSHOT = "browser_screenshot"
export const TOOL_BROWSER_EXTRACT = "browser_extract"
export const TOOL_BROWSER_WAIT = "browser_wait"
export const TOOL_BROWSER_CLICK = "browser_click"
export const TOOL_BROWSER_TYPE = "browser_type"

export const BROWSER_TOOL_NAMES = [
  TOOL_BROWSER_NAVIGATE,
  TOOL_BROWSER_SCREENSHOT,
  TOOL_BROWSER_EXTRACT,
  TOOL_BROWSER_WAIT,
  TOOL_BROWSER_CLICK,
  TOOL_BROWSER_TYPE,
] as const

export const TOOL_CONTRACT_NAMES = [
  TOOL_TODOWRITE,
  TOOL_WEBFETCH,
  TOOL_WEBSEARCH,
  TOOL_QUESTION,
  TOOL_AGENT_LEGACY,
  TOOL_AGENT,
] as const

export type ToolContractName = (typeof TOOL_CONTRACT_NAMES)[number]

export const HIDDEN_TOOL_NAMES = [TOOL_TODOWRITE] as const
