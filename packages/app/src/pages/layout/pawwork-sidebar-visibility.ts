export function shouldShowPawworkSidebarNav(input: {
  hasSessions: boolean
  canShowMore: boolean
  capReached: boolean
  hasWorkspacePicker: boolean
}) {
  return input.hasSessions || input.canShowMore || input.capReached || input.hasWorkspacePicker
}
