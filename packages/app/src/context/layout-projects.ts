import { batch, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { useGlobalSDK } from "./global-sdk"
import type { useGlobalSync } from "./global-sync"
import type { useServer } from "./server"
import { AVATAR_COLOR_KEYS, type AvatarColorKey } from "./layout-state"

export type PawworkLayoutProjectsInput = {
  globalSDK: Pick<ReturnType<typeof useGlobalSDK>, "client">
  globalSync: Pick<ReturnType<typeof useGlobalSync>, "child" | "data" | "project" | "ready">
  server: Pick<ReturnType<typeof useServer>, "projects">
}

export function createPawworkLayoutProjects(input: PawworkLayoutProjectsInput) {
  const [colors, setColors] = createStore<Record<string, AvatarColorKey>>({})
  const colorRequested = new Map<string, AvatarColorKey>()

  function pickAvailableColor(used: Set<string>): AvatarColorKey {
    const available = AVATAR_COLOR_KEYS.filter((c) => !used.has(c))
    if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
    return available[Math.floor(Math.random() * available.length)]
  }

  function enrich(project: { worktree: string; expanded: boolean }) {
    const [childStore] = input.globalSync.child(project.worktree, { bootstrap: false })
    const projectID = childStore.project
    const metadata = projectID
      ? input.globalSync.data.project.find((x) => x.id === projectID)
      : input.globalSync.data.project.find((x) => x.worktree === project.worktree)

    const local = childStore.projectMeta
    const localOverride =
      local?.name !== undefined ||
      local?.commands?.start !== undefined ||
      local?.icon?.override !== undefined ||
      local?.icon?.color !== undefined

    const base = {
      ...metadata,
      ...project,
      icon: {
        url: metadata?.icon?.url,
        override: metadata?.icon?.override ?? childStore.icon,
        color: metadata?.icon?.color,
      },
    }

    const isGlobal = projectID === "global" || (metadata?.id === undefined && localOverride)
    if (!isGlobal) return base

    return {
      ...base,
      id: base.id ?? "global",
      name: local?.name,
      commands: local?.commands,
      icon: {
        url: base.icon?.url,
        override: local?.icon?.override,
        color: local?.icon?.color,
      },
    }
  }

  const roots = createMemo(() => {
    const map = new Map<string, string>()
    for (const project of input.globalSync.data.project) {
      const sandboxes = project.sandboxes ?? []
      for (const sandbox of sandboxes) {
        map.set(sandbox, project.worktree)
      }
    }
    return map
  })

  const rootFor = (directory: string) => {
    const map = roots()
    if (map.size === 0) return directory

    const visited = new Set<string>()
    const chain = [directory]

    while (chain.length) {
      const current = chain[chain.length - 1]
      if (!current) return directory

      const next = map.get(current)
      if (!next) return current

      if (visited.has(next)) return directory
      visited.add(next)
      chain.push(next)
    }

    return directory
  }

  createEffect(() => {
    const projects = input.server.projects.list()
    const seen = new Set(projects.map((project) => project.worktree))

    batch(() => {
      for (const project of projects) {
        const root = rootFor(project.worktree)
        if (root === project.worktree) continue

        input.server.projects.close(project.worktree)

        if (!seen.has(root)) {
          input.server.projects.open(root)
          seen.add(root)
        }

        if (project.expanded) input.server.projects.expand(root)
      }
    })
  })

  const enriched = createMemo(() => input.server.projects.list().map(enrich))
  const list = createMemo(() => {
    const projects = enriched()
    return projects.map((project) => {
      const color = project.icon?.color ?? colors[project.worktree]
      if (!color) return project
      const icon = project.icon ? { ...project.icon, color } : { color }
      return { ...project, icon }
    })
  })

  createEffect(() => {
    const projects = enriched()
    if (projects.length === 0) return
    if (!input.globalSync.ready) return

    for (const project of projects) {
      if (!project.id) continue
      if (project.id === "global") continue
      input.globalSync.project.icon(project.worktree, project.icon?.override)
    }
  })

  createEffect(() => {
    const projects = enriched()
    if (projects.length === 0) return

    for (const project of projects) {
      if (project.icon?.color) colorRequested.delete(project.worktree)
    }

    const used = new Set<string>()
    for (const project of projects) {
      const color = project.icon?.color ?? colors[project.worktree]
      if (color) used.add(color)
    }

    for (const project of projects) {
      if (project.icon?.color) continue
      const worktree = project.worktree
      const existing = colors[worktree]
      const color = existing ?? pickAvailableColor(used)
      if (!existing) {
        used.add(color)
        setColors(worktree, color)
      }
      if (!project.id) continue

      const requested = colorRequested.get(worktree)
      if (requested === color) continue
      colorRequested.set(worktree, color)

      if (project.id === "global") {
        input.globalSync.project.meta(worktree, { icon: { color } })
        continue
      }

      void input.globalSDK.client.project
        .update({ projectID: project.id, directory: worktree, icon: { color } })
        .catch(() => {
          if (colorRequested.get(worktree) === color) colorRequested.delete(worktree)
        })
    }
  })

  let sessionFrame: number | undefined
  let sessionTimer: number | undefined

  onMount(() => {
    sessionFrame = requestAnimationFrame(() => {
      sessionFrame = undefined
      sessionTimer = window.setTimeout(() => {
        sessionTimer = undefined
        void Promise.all(
          input.server.projects.list().map((project) => {
            return input.globalSync.project.loadSessions(project.worktree)
          }),
        )
      }, 0)
    })
  })

  onCleanup(() => {
    if (sessionFrame !== undefined) cancelAnimationFrame(sessionFrame)
    if (sessionTimer !== undefined) window.clearTimeout(sessionTimer)
  })

  return { list, rootFor }
}
