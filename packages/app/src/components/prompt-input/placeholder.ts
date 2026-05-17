type PromptPlaceholderInput = {
  mode: "normal" | "shell"
  commentCount: number
  t: (key: string) => string
}

export function promptPlaceholder(input: PromptPlaceholderInput) {
  if (input.mode === "shell") return input.t("prompt.placeholder.shell")
  if (input.commentCount > 1) return input.t("prompt.placeholder.summarizeComments")
  if (input.commentCount === 1) return input.t("prompt.placeholder.summarizeComment")
  return input.t("prompt.placeholder.home")
}
