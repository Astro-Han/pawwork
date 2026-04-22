import type { Platform } from "@/context/platform"

type PickerResult = string | string[] | null

export async function pickAttachments(input: {
  openFilePickerDialog?: Platform["openFilePickerDialog"]
  addPickedPaths: (paths: string[]) => Promise<boolean>
  fallbackInputClick: () => void
}) {
  if (!input.openFilePickerDialog) {
    input.fallbackInputClick()
    return false
  }

  let result: PickerResult
  try {
    result = await input.openFilePickerDialog({ multiple: true, extensions: [] })
  } catch (err) {
    console.warn("Native file picker failed, using browser fallback", err)
    input.fallbackInputClick()
    return false
  }
  if (!result) return false

  const paths = (Array.isArray(result) ? result : [result]).filter((path) => path.length > 0)
  if (paths.length === 0) return false
  try {
    return await input.addPickedPaths(paths)
  } catch (err) {
    console.error("Adding picked attachments failed", err)
    return false
  }
}
