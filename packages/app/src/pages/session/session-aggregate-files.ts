import type { SessionDiffResponse, SnapshotFileDiff } from "@opencode-ai/sdk/v2/client"

export function aggregateFiles(aggregate: SessionDiffResponse | undefined): SnapshotFileDiff[] {
  if (!aggregate) return []
  if (aggregate.kind === "empty" || aggregate.kind === "uncaptured") return []
  return aggregate.files
    .filter((file) => file.restoreState === "applied")
    .map((file) => ({
      file: file.openPath ?? file.path,
      patch: file.patch ?? "",
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      status: file.status,
    }))
}
