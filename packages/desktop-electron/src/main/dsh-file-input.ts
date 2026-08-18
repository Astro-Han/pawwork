export type ConversationFilePickerResult =
  | { status: "canceled" }
  | { status: "selected"; paths: string[] }

type ShowOpenDialog = (options: {
  properties: Array<"openFile" | "multiSelections">
}) => Promise<{ canceled: boolean; filePaths: string[] }>

export async function pickConversationFiles(showOpenDialog: ShowOpenDialog): Promise<ConversationFilePickerResult> {
  const result = await showOpenDialog({ properties: ["openFile", "multiSelections"] })
  return result.canceled ? { status: "canceled" } : { status: "selected", paths: result.filePaths }
}
