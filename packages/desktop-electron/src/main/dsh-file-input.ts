import { decideDshNavigation } from "./window-navigation"

export type ConversationFilePickerResult =
  | { status: "canceled" }
  | { status: "selected"; paths: string[] }

type ShowOpenDialog = (options: {
  properties: Array<"openFile" | "multiSelections">
}) => Promise<{ canceled: boolean; filePaths: string[] }>

export async function pickConversationFiles(
  dshUrl: string,
  senderUrl: string,
  showOpenDialog: ShowOpenDialog,
): Promise<ConversationFilePickerResult> {
  if (decideDshNavigation(dshUrl, senderUrl) !== "same-window") {
    throw new Error("File picker requests must come from the owned DSH origin")
  }
  const result = await showOpenDialog({ properties: ["openFile", "multiSelections"] })
  return result.canceled ? { status: "canceled" } : { status: "selected", paths: result.filePaths }
}
