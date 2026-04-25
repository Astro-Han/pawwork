import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { Effect } from "effect"
import { Runtime } from "@opencode-ai/shared/runtime"
import { Session } from "."
import type { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import type { Snapshot as SnapshotMod } from "../snapshot"
import { Installation } from "../installation"
import { Provider } from "../provider/provider"
import { ProviderID, ModelID } from "../provider/schema"
import { Instance } from "../project/instance"
import { Global } from "../global"

export function getRuntimeNamespace(): "pawwork" | "opencode" {
  return Runtime.isPawWork() ? "pawwork" : "opencode"
}

async function hashFile(p: string) {
  try {
    const buf = await fs.readFile(p)
    return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex")
  } catch {
    return undefined
  }
}

function redactDataUrl(url: string): { mime: string; size_bytes: number; sha256: string } | null {
  // RFC 2397 allows zero-or-more `;param=value` segments between mime and the optional `;base64` flag,
  // e.g. `data:text/plain;charset=utf-8;base64,...`. Lazy params group lets `;base64` still anchor.
  const match = /^data:([^;,]+)((?:;[^;,]+)*?)(;base64)?,(.*)$/s.exec(url)
  if (!match) return null
  const [, mime, , isBase64, payload] = match
  const buf = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(payload, "utf8")
  return {
    mime,
    size_bytes: buf.byteLength,
    sha256: "sha256:" + crypto.createHash("sha256").update(buf).digest("hex"),
  }
}

export function redactPart(
  part: MessageV2.Part,
  ctx: { count: { omitted: number } },
): MessageV2.Part {
  if (part.type === "file") {
    const r = redactDataUrl(part.url)
    if (!r) return part
    ctx.count.omitted++
    return {
      ...part,
      url: "",
      metadata: { ...(part.metadata ?? {}), redacted_binary: r },
    }
  }
  if (part.type === "tool" && part.state.status === "completed" && part.state.attachments) {
    let mutated = false
    const attachments = part.state.attachments.map((a) => {
      const r = redactDataUrl(a.url)
      if (!r) return a
      mutated = true
      ctx.count.omitted++
      return { ...a, url: "", metadata: { ...(a.metadata ?? {}), redacted_binary: r } }
    })
    return mutated ? { ...part, state: { ...part.state, attachments } } : part
  }
  return part
}

function extractReasonFromCause(cause: unknown): string {
  // Cause shape in Effect 4.x: { reasons: Array<{ _tag, error?, defect?, ... }> }
  // We only need a reason string for diagnostics — best-effort extraction without depending
  // on a stable Cause API surface (Cause.failureOption was removed in this version).
  const reasons = (cause as { reasons?: unknown[] } | undefined)?.reasons ?? []
  for (const r of reasons as Array<{ _tag?: string; error?: unknown; defect?: unknown }>) {
    const payload = r.error ?? r.defect
    if (typeof payload === "string") return payload
    const p = payload as { _tag?: string; message?: string } | undefined
    if (p?.message) return p.message
    if (p?._tag) return p._tag
  }
  return "unknown"
}

export namespace Export {
  export type Tree = {
    info: Omit<Session.Info, "share">
    had_cloud_share: boolean
    diffs: SnapshotMod.FileDiff[]
    messages: MessageV2.WithParts[]
    children: Tree[]
  }

  export type ModelRefEntry =
    | { providerID: string; modelID: string; resolved: true }
    | { providerID: string; modelID: string; resolved: false; unresolved_reason: string }

  export type InstructionSource = {
    kind: string
    path?: string
    url?: string
    hash?: string
    hash_unavailable?: true
  }

  export type Snapshot = {
    schema_version: 1
    format: "pawwork-session-export"
    exported_at: number
    root_session_id: SessionID
    runtime_context: {
      app_version: string
      build_channel?: string
      runtime_namespace: "pawwork" | "opencode"
      platform: NodeJS.Platform
      os_version: string
      locale: string
      timezone: string
      instruction_sources: InstructionSource[]
      model_refs: Record<string, ModelRefEntry>
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

  const buildNode = Effect.fn("Export.buildNode")(function* (
    svc: Session.Interface,
    info: Session.Info,
    ctx: { count: { omitted: number } },
  ) {
    const messages = yield* svc.messages({ sessionID: info.id })
    const diffs = yield* svc.diff(info.id)
    const children = yield* svc.children(info.id)
    const sorted = [...children].sort((a, b) => {
      if (a.time.created !== b.time.created) return a.time.created - b.time.created
      return a.id.localeCompare(b.id)
    })
    const { share, ...infoWithoutShare } = info as Session.Info & { share?: unknown }
    const redactedMessages = messages.map((m) => ({ ...m, parts: m.parts.map((p) => redactPart(p, ctx)) }))
    const node: Tree = {
      info: infoWithoutShare as Omit<Session.Info, "share">,
      had_cloud_share: !!(share as { url?: string } | undefined)?.url,
      diffs,
      messages: redactedMessages,
      children: [],
    }
    const data: NodeData = { node, childInfos: sorted }
    return data
  })

  const exportTree = Effect.fn("Export.exportTree")(function* (
    svc: Session.Interface,
    root: Session.Info,
    ctx: { count: { omitted: number } },
  ) {
    const rootData = yield* buildNode(svc, root, ctx)
    const queue: NodeData[] = [rootData]
    let head = 0
    while (head < queue.length) {
      const cur = queue[head++]
      for (const childInfo of cur.childInfos) {
        const childData = yield* buildNode(svc, childInfo, ctx)
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

  const collectInstructionSources = Effect.fn("Export.instructionSources")(function* () {
    const sources: InstructionSource[] = []
    let worktree: string | undefined
    try {
      worktree = Instance.worktree
    } catch {
      worktree = undefined
    }
    const candidates: Array<{ kind: string; file: string }> = [
      { kind: "global", file: path.join(Global.Path.config, "AGENTS.md") },
      ...(worktree ? [{ kind: "project", file: path.join(worktree, "AGENTS.md") }] : []),
      // Bundled pawwork prompt — present in the repo at packages/opencode/src/session/prompt/pawwork.txt.
      // hashFile silently returns undefined and the entry is skipped if the file is missing.
      { kind: "bundled", file: path.join(__dirname, "prompt", "pawwork.txt") },
    ]
    for (const c of candidates) {
      const hash = yield* Effect.promise(() => hashFile(c.file))
      if (hash) sources.push({ kind: c.kind, path: c.file, hash })
    }
    return sources.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
      return (a.path ?? a.url ?? "").localeCompare(b.path ?? b.url ?? "")
    })
  })

  // Exported so it can be unit-tested with synthesized Tree fixtures.
  export const collectModelRefs = Effect.fn("Export.modelRefs")(function* (tree: Tree) {
    const provider = yield* Provider.Service
    const seen = new Map<string, { providerID: string; modelID: string }>()
    function walk(node: Tree) {
      for (const m of node.messages) {
        if (m.info.role !== "user") continue
        const ref = m.info.model
        const key = `${ref.providerID}/${ref.modelID}`
        if (!seen.has(key)) seen.set(key, { providerID: ref.providerID, modelID: ref.modelID })
      }
      for (const c of node.children) walk(c)
    }
    walk(tree)
    const refs: Record<string, ModelRefEntry> = {}
    for (const [key, ref] of [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const entry = yield* Effect.matchCause(
        provider.getModel(ProviderID.make(ref.providerID), ModelID.make(ref.modelID)),
        {
          onSuccess: (): ModelRefEntry => ({
            providerID: ref.providerID,
            modelID: ref.modelID,
            resolved: true,
          }),
          onFailure: (cause): ModelRefEntry => {
            // The provider throws ModelNotFoundError inside Effect.gen → arrives as a defect.
            // matchCause handles both typed failures and defects; reach into cause.reasons to extract.
            const reason = extractReasonFromCause(cause)
            return {
              providerID: ref.providerID,
              modelID: ref.modelID,
              resolved: false,
              unresolved_reason: reason,
            }
          },
        },
      )
      refs[key] = entry
    }
    return refs
  })

  export const session = Effect.fn("Export.session")(function* (anyID: SessionID) {
    const svc = yield* Session.Service
    const root = yield* climbToRoot(svc, anyID)
    const ctx = { count: { omitted: 0 } }
    const tree = yield* exportTree(svc, root, ctx)
    const instruction_sources = yield* collectInstructionSources()
    const model_refs = yield* collectModelRefs(tree)
    return {
      schema_version: 1 as const,
      format: "pawwork-session-export" as const,
      exported_at: Date.now(),
      root_session_id: root.id,
      runtime_context: {
        app_version: Installation.VERSION,
        ...(Installation.CHANNEL ? { build_channel: Installation.CHANNEL } : {}),
        runtime_namespace: getRuntimeNamespace(),
        platform: process.platform,
        os_version: os.release(),
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        instruction_sources,
        model_refs,
        stats: countStats(tree, ctx.count.omitted),
      },
      diagnostics: {},
      session: tree,
    } satisfies Snapshot
  })

  // ----- Sanitize helpers (moved from cli/cmd/export.ts so CLI + future surfaces share them) -----

  function redact(kind: string, id: string, value: string) {
    return value.trim() ? `[redacted:${kind}:${id}]` : value
  }

  function dataField(kind: string, id: string, value: Record<string, unknown> | undefined) {
    if (!value) return value
    return Object.keys(value).length ? { redacted: `${kind}:${id}` } : value
  }

  function span(id: string, value: { value: string; start: number; end: number }) {
    return {
      ...value,
      value: redact("file-text", id, value.value),
    }
  }

  function diff(kind: string, diffs: { file: string; patch: string }[] | undefined) {
    return diffs?.map((item, i) => ({
      ...item,
      file: redact(`${kind}-file`, String(i), item.file),
      patch: redact(`${kind}-patch`, String(i), item.patch),
    }))
  }

  function source(part: MessageV2.FilePart) {
    if (!part.source) return part.source
    if (part.source.type === "symbol") {
      return {
        ...part.source,
        path: redact("file-path", part.id, part.source.path),
        name: redact("file-symbol", part.id, part.source.name),
        text: span(part.id, part.source.text),
      }
    }
    if (part.source.type === "resource") {
      return {
        ...part.source,
        clientName: redact("file-client", part.id, part.source.clientName),
        uri: redact("file-uri", part.id, part.source.uri),
        text: span(part.id, part.source.text),
      }
    }
    return {
      ...part.source,
      path: redact("file-path", part.id, part.source.path),
      text: span(part.id, part.source.text),
    }
  }

  function filepart(part: MessageV2.FilePart): MessageV2.FilePart {
    return {
      ...part,
      url: redact("file-url", part.id, part.url),
      filename: part.filename === undefined ? undefined : redact("file-name", part.id, part.filename),
      source: source(part),
    }
  }

  function errorData(kind: string, id: string, value: Record<string, unknown> | undefined) {
    if (!value) return value
    return {
      ...value,
      message: typeof value.message === "string" ? redact(`${kind}-message`, id, value.message) : value.message,
      responseBody:
        typeof value.responseBody === "string" ? redact(`${kind}-body`, id, value.responseBody) : value.responseBody,
      responseHeaders: dataField(`${kind}-headers`, id, value.responseHeaders as Record<string, unknown> | undefined),
      metadata: dataField(`${kind}-metadata`, id, value.metadata as Record<string, unknown> | undefined),
    }
  }

  function namedError<T extends { data?: Record<string, unknown> }>(kind: string, id: string, error: T): T
  function namedError<T extends { data?: Record<string, unknown> }>(
    kind: string,
    id: string,
    error: T | undefined,
  ): T | undefined
  function namedError<T extends { data?: Record<string, unknown> }>(kind: string, id: string, error: T | undefined) {
    if (!error) return error
    return {
      ...error,
      data: errorData(kind, id, error.data),
    }
  }

  function part(part: MessageV2.Part): MessageV2.Part {
    switch (part.type) {
      case "text":
        return {
          ...part,
          text: redact("text", part.id, part.text),
          metadata: dataField("text-metadata", part.id, part.metadata),
        }
      case "reasoning":
        return {
          ...part,
          text: redact("reasoning", part.id, part.text),
          metadata: dataField("reasoning-metadata", part.id, part.metadata),
        }
      case "file":
        return filepart(part)
      case "subtask":
        return {
          ...part,
          prompt: redact("subtask-prompt", part.id, part.prompt),
          description: redact("subtask-description", part.id, part.description),
          command: part.command === undefined ? undefined : redact("subtask-command", part.id, part.command),
        }
      case "tool":
        switch (part.state.status) {
          case "pending":
            return {
              ...part,
              metadata: dataField("tool-metadata", part.id, part.metadata),
              state: {
                ...part.state,
                input: dataField("tool-input", part.id, part.state.input) ?? part.state.input,
                raw: redact("tool-raw", part.id, part.state.raw),
              },
            }
          case "running":
            return {
              ...part,
              metadata: dataField("tool-metadata", part.id, part.metadata),
              state: {
                ...part.state,
                input: dataField("tool-input", part.id, part.state.input) ?? part.state.input,
                title: part.state.title === undefined ? undefined : redact("tool-title", part.id, part.state.title),
                metadata: dataField("tool-state-metadata", part.id, part.state.metadata),
              },
            }
          case "completed":
            return {
              ...part,
              metadata: dataField("tool-metadata", part.id, part.metadata),
              state: {
                ...part.state,
                input: dataField("tool-input", part.id, part.state.input) ?? part.state.input,
                output: redact("tool-output", part.id, part.state.output),
                title: redact("tool-title", part.id, part.state.title),
                metadata: dataField("tool-state-metadata", part.id, part.state.metadata) ?? part.state.metadata,
                attachments: part.state.attachments?.map(filepart),
              },
            }
          case "error":
            return {
              ...part,
              metadata: dataField("tool-metadata", part.id, part.metadata),
              state: {
                ...part.state,
                input: dataField("tool-input", part.id, part.state.input) ?? part.state.input,
                error: redact("tool-error", part.id, part.state.error),
                metadata: dataField("tool-state-metadata", part.id, part.state.metadata) ?? part.state.metadata,
              },
            }
        }
      case "patch":
        return {
          ...part,
          hash: redact("patch", part.id, part.hash),
          files: part.files.map((item: string, i: number) => redact("patch-file", `${part.id}-${i}`, item)),
        }
      case "snapshot":
        return {
          ...part,
          snapshot: redact("snapshot", part.id, part.snapshot),
        }
      case "step-start":
        return {
          ...part,
          snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
        }
      case "step-finish":
        return {
          ...part,
          snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
        }
      case "agent":
        return {
          ...part,
          source: !part.source
            ? part.source
            : {
                ...part.source,
                value: redact("agent-source", part.id, part.source.value),
              },
        }
      case "retry":
        return {
          ...part,
          error: namedError("retry-error", part.id, part.error),
        }
      default:
        return part
    }
  }

  const partFn = part

  export function sanitize(data: { info: Session.Info; messages: MessageV2.WithParts[] }) {
    return {
      info: {
        ...data.info,
        title: redact("session-title", data.info.id, data.info.title),
        directory: redact("session-directory", data.info.id, data.info.directory),
        share: !data.info.share
          ? data.info.share
          : {
              ...data.info.share,
              url: redact("session-share", data.info.id, data.info.share.url),
            },
        summary: !data.info.summary
          ? data.info.summary
          : {
              ...data.info.summary,
              diffs: diff("session-diff", data.info.summary.diffs),
            },
        revert: !data.info.revert
          ? data.info.revert
          : {
              ...data.info.revert,
              snapshot:
                data.info.revert.snapshot === undefined
                  ? undefined
                  : redact("revert-snapshot", data.info.id, data.info.revert.snapshot),
              diff:
                data.info.revert.diff === undefined
                  ? undefined
                  : redact("revert-diff", data.info.id, data.info.revert.diff),
            },
      },
      messages: data.messages.map((msg) => ({
        info:
          msg.info.role === "user"
            ? {
                ...msg.info,
                system: msg.info.system === undefined ? undefined : redact("system", msg.info.id, msg.info.system),
                summary: !msg.info.summary
                  ? msg.info.summary
                  : {
                      ...msg.info.summary,
                      title:
                        msg.info.summary.title === undefined
                          ? undefined
                          : redact("summary-title", msg.info.id, msg.info.summary.title),
                      body:
                        msg.info.summary.body === undefined
                          ? undefined
                          : redact("summary-body", msg.info.id, msg.info.summary.body),
                      diffs: diff("message-diff", msg.info.summary.diffs),
                    },
              }
            : {
                ...msg.info,
                path: {
                  cwd: redact("cwd", msg.info.id, msg.info.path.cwd),
                  root: redact("root", msg.info.id, msg.info.path.root),
                },
                structured:
                  msg.info.structured === undefined ? undefined : { redacted: `assistant-structured:${msg.info.id}` },
                error: namedError("assistant-error", msg.info.id, msg.info.error),
              },
        parts: msg.parts.map(partFn),
      })),
    }
  }

  export function sanitizeTree(node: Tree): Tree {
    const out = sanitize({ info: node.info as Session.Info, messages: node.messages })
    // Sanitize replaces sensitive strings with redaction markers but preserves structural shape;
    // the inferred type narrows summary.diffs in ways the strict MessageV2 schema rejects, so cast
    // at this boundary instead of weakening every helper signature in the pipeline.
    // Tree.diffs carries raw file paths + source patches; redact via the existing diff() helper.
    const sanitizedDiffs = (diff("tree-diff", node.diffs) ?? []) as Tree["diffs"]
    return {
      ...node,
      info: out.info as Omit<Session.Info, "share">,
      diffs: sanitizedDiffs,
      messages: out.messages as MessageV2.WithParts[],
      children: node.children.map(sanitizeTree),
    }
  }

  // Snapshot-level sanitize. Wraps sanitizeTree (the conversation tree) AND redacts top-level
  // runtime_context fields that may carry user-machine paths (instruction_sources). Other
  // runtime_context fields (app_version, build_channel, locale, timezone, model_refs, stats)
  // are not user-identifying and are kept verbatim.
  export function sanitizeSnapshot(snap: Snapshot): Snapshot {
    return {
      ...snap,
      runtime_context: {
        ...snap.runtime_context,
        instruction_sources: snap.runtime_context.instruction_sources.map((s, i) => ({
          ...s,
          path: s.path === undefined ? undefined : redact("instruction-path", String(i), s.path),
          url: s.url === undefined ? undefined : redact("instruction-url", String(i), s.url),
        })),
      },
      session: sanitizeTree(snap.session),
    }
  }
}
