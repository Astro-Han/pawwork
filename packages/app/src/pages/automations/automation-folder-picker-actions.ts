export function openProjectFromAutomationFolderPicker(setOpen: (open: boolean) => void, onOpenProject?: () => void) {
  setOpen(false)
  onOpenProject?.()
}
