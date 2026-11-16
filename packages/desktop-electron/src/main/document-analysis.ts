export type DocumentAction = "ocr" | "drawing" | "compare"

export function documentPrompt(action: DocumentAction, file: string, page: number, otherFile?: string) {
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new Error("Invalid PDF page")
  const source = JSON.stringify(file)
  if (action === "ocr") {
    return `Read page ${page} of ${source}. Render the page if needed and transcribe all visible text. Mark uncertain characters and do not invent unreadable text.`
  }
  if (action === "drawing") {
    return `Visually inspect page ${page} of ${source} as a technical drawing. Describe visible dimensions, labels, components, and notable issues with page references. Do not infer details you cannot see.`
  }
  if (!otherFile) throw new Error("Choose a second revision")
  return `Compare page ${page} of ${source} with the corresponding page of ${JSON.stringify(otherFile)}. List added, removed, and changed text and drawing details. State any pages you could not inspect.`
}
