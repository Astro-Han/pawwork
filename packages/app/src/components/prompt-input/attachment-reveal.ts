import type { Platform } from "@/context/platform"
import { toAbsoluteFilePath } from "./path-canonical"

export function showAttachmentInFolder(input: {
  platform: Pick<Platform, "showItemInFolder">
  directory: string
  path: string
}) {
  const absolutePath = toAbsoluteFilePath(input.directory, input.path)
  void input.platform.showItemInFolder?.(absolutePath)
}
