import { createResource, type Accessor } from "solid-js"

type ArtifactStats = Record<string, { size: number; exists: boolean }>

export function createArtifactFileExists(
  paths: Accessor<string[]>,
  statPaths: (paths: string[]) => Promise<ArtifactStats> | undefined,
) {
  const [stats] = createResource(
    paths,
    async (nextPaths) => {
      if (nextPaths.length === 0) return {} as ArtifactStats
      return statPaths(nextPaths) ?? Object.fromEntries(nextPaths.map((path) => [path, { size: 0, exists: true }]))
    },
    { initialValue: {} as ArtifactStats },
  )

  return (path: string) => stats.latest[path]?.exists ?? true
}
