import { Effect } from "effect"
import { Runtime } from "@opencode-ai/shared/runtime"
import { Session } from "."
import type { SessionID } from "./schema"
import type { MessageV2 } from "./message-v2"
import type { Snapshot as SnapshotMod } from "../snapshot"

export function getRuntimeNamespace(): "pawwork" | "opencode" {
  return Runtime.isPawWork() ? "pawwork" : "opencode"
}

export namespace Export {
  export type Tree = {
    info: Omit<Session.Info, "share">
    had_cloud_share: boolean
    diffs: SnapshotMod.FileDiff[]
    messages: MessageV2.WithParts[]
    children: Tree[]
  }

  export type Snapshot = {
    schema_version: 1
    format: "pawwork-session-export"
    exported_at: number
    root_session_id: SessionID
    runtime_context: {
      runtime_namespace: "pawwork" | "opencode"
      stats: {
        session_count: number
        message_count: number
        part_count: number
        omitted_attachment_count: number
      }
    }
    diagnostics: Record<string, never>
    session: Tree
  }

  type NodeData = {
    node: Tree
    childInfos: Session.Info[]
  }

  const climbToRoot = Effect.fn("Export.climbToRoot")(function* (svc: Session.Interface, id: SessionID) {
    let current: Session.Info = yield* svc.get(id)
    while (current.parentID) {
      current = yield* svc.get(current.parentID)
    }
    return current
  })

  // Builds a single node and returns it alongside its sorted child infos.
  // Non-recursive on purpose: BFS in `exportTree` links parents → children iteratively,
  // sidestepping TypeScript's collapse of recursive Effect generator return types.
  const buildNode = Effect.fn("Export.buildNode")(function* (svc: Session.Interface, info: Session.Info) {
    const messages = yield* svc.messages({ sessionID: info.id })
    const diffs = yield* svc.diff(info.id)
    const children = yield* svc.children(info.id)
    const sorted = [...children].sort((a, b) => {
      if (a.time.created !== b.time.created) return a.time.created - b.time.created
      return a.id.localeCompare(b.id)
    })
    const { share, ...infoWithoutShare } = info as Session.Info & { share?: unknown }
    const node: Tree = {
      info: infoWithoutShare as Omit<Session.Info, "share">,
      had_cloud_share: !!(share as { url?: string } | undefined)?.url,
      diffs,
      // Task 4 wraps each part with redactPart(p, ctx); kept untouched here.
      messages,
      children: [],
    }
    const data: NodeData = { node, childInfos: sorted }
    return data
  })

  const exportTree = Effect.fn("Export.exportTree")(function* (svc: Session.Interface, root: Session.Info) {
    const rootData = yield* buildNode(svc, root)
    const queue: NodeData[] = [rootData]
    let head = 0
    while (head < queue.length) {
      const cur = queue[head++]
      for (const childInfo of cur.childInfos) {
        const childData = yield* buildNode(svc, childInfo)
        cur.node.children.push(childData.node)
        queue.push(childData)
      }
    }
    return rootData.node
  })

  function countStats(tree: Tree, omitted_attachment_count: number) {
    let session_count = 0
    let message_count = 0
    let part_count = 0
    function walk(node: Tree) {
      session_count++
      message_count += node.messages.length
      for (const m of node.messages) part_count += m.parts.length
      for (const c of node.children) walk(c)
    }
    walk(tree)
    return { session_count, message_count, part_count, omitted_attachment_count }
  }

  export const session = Effect.fn("Export.session")(function* (anyID: SessionID) {
    const svc = yield* Session.Service
    const root = yield* climbToRoot(svc, anyID)
    // ctx is allocated once. Task 4 fills the redact path; Task 2 keeps it 0.
    const ctx = { count: { omitted: 0 } }
    const tree = yield* exportTree(svc, root)
    return {
      schema_version: 1 as const,
      format: "pawwork-session-export" as const,
      exported_at: Date.now(),
      root_session_id: root.id,
      runtime_context: {
        runtime_namespace: getRuntimeNamespace(),
        stats: countStats(tree, ctx.count.omitted),
      },
      diagnostics: {},
      session: tree,
    } satisfies Snapshot
  })
}
