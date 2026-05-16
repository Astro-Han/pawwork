export const TOOL_TODOWRITE = "todowrite"
export const TOOL_WEBFETCH = "webfetch"
export const TOOL_WEBSEARCH = "websearch"
export const TOOL_QUESTION = "question"
export const TOOL_AGENT_LEGACY = "task"
export const TOOL_AGENT = "agent"

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
