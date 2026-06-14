# Effect patterns

Practical reference for new and migrated Effect code in `packages/opencode`.

## Choose scope

Use `InstanceState` (from `src/effect/instance-state.ts`) for services that need per-directory state, per-instance cleanup, or project-bound background work. InstanceState uses a `ScopedCache` keyed by directory, so each open project gets its own copy of the state that is automatically cleaned up on disposal.

Use `makeRuntime` (from `src/effect/run-service.ts`) to create a per-service `ManagedRuntime` that lazily initializes and shares layers via a global `memoMap`. Returns `{ runPromise, runFork, runCallback }`.

- Global services (no per-directory state): Account, Auth, AppFileSystem, Installation, Truncate, Worktree
- Instance-scoped (per-directory state via InstanceState): Agent, Bus, Command, Config, File, FileTime, FileWatcher, Format, LSP, MCP, Permission, Plugin, ProviderAuth, Pty, Question, SessionStatus, Skill, Snapshot, ToolRegistry, Vcs

Rule of thumb: if two open directories should not share one copy of the service, it needs `InstanceState`.

## Service shape

Every service follows the same pattern — a single namespace with the service definition, layer, `runPromise`, and async facade functions:

```ts
export namespace Foo {
  export interface Interface {
    readonly get: (id: FooID) => Effect.Effect<FooInfo, FooError>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      // For instance-scoped services:
      const state = yield* InstanceState.make<State>(
        Effect.fn("Foo.state")(() => Effect.succeed({ ... })),
      )

      const get = Effect.fn("Foo.get")(function* (id: FooID) {
        const s = yield* InstanceState.get(state)
        // ...
      })

      return Service.of({ get })
    }),
  )

  // Optional: wire dependencies
  export const defaultLayer = layer.pipe(Layer.provide(FooDep.layer))

  // Per-service runtime (inside the namespace)
  const { runPromise } = makeRuntime(Service, defaultLayer)

  // Async facade functions
  export async function get(id: FooID) {
    return runPromise((svc) => svc.get(id))
  }
}
```

Rules:

- Keep everything in one namespace, one file — no separate `service.ts` / `index.ts` split
- `runPromise` goes inside the namespace (not exported unless tests need it)
- Facade functions are plain `async function` — no `fn()` wrappers
- Use `Effect.fn("Namespace.method")` for all Effect functions (for tracing)
- No `Layer.fresh` — InstanceState handles per-directory isolation

## Schema → Zod interop

When a service uses Effect Schema internally but needs Zod schemas for the HTTP layer, derive Zod from Schema using the `zod()` helper from `@/util/effect-zod`:

```ts
import { zod } from "@/util/effect-zod"

export const ZodInfo = zod(Info) // derives z.ZodType from Schema.Union
```

See `Auth.ZodInfo` for the canonical example.

## InstanceState init patterns

The `InstanceState.make` init callback receives a `Scope`, so you can use `Effect.acquireRelease`, `Effect.addFinalizer`, and `Effect.forkScoped` inside it. Resources acquired this way are automatically cleaned up when the instance is disposed or invalidated by `ScopedCache`. This makes it the right place for:

- **Subscriptions**: Yield `Bus.Service` at the layer level, then use `Stream` + `forkScoped` inside the init closure. The fiber is automatically interrupted when the instance scope closes:

```ts
const bus = yield * Bus.Service

const cache =
  yield *
  InstanceState.make<State>(
    Effect.fn("Foo.state")(function* (ctx) {
      // ... load state ...

      yield* bus.subscribeAll().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            /* handle */
          }),
        ),
        Effect.forkScoped,
      )

      return {
        /* state */
      }
    }),
  )
```

- **Resource cleanup**: Use `Effect.acquireRelease` or `Effect.addFinalizer` for resources that need teardown (native watchers, process handles, etc.):

```ts
yield *
  Effect.acquireRelease(
    Effect.sync(() => nativeAddon.watch(dir)),
    (watcher) => Effect.sync(() => watcher.close()),
  )
```

- **Background fibers**: Use `Effect.forkScoped` — the fiber is interrupted on disposal.
- **Side effects at init**: Config notification, event wiring, etc. all belong in the init closure. Callers just do `InstanceState.get(cache)` to trigger everything, and `ScopedCache` deduplicates automatically.

The key insight: don't split init into a separate method with a `started` flag. Put everything in the `InstanceState.make` closure and let `ScopedCache` handle the run-once semantics.

## Effect.cached for deduplication

Use `Effect.cached` when multiple concurrent callers should share a single in-flight computation. It memoizes the result and deduplicates concurrent fibers — second caller joins the first caller's fiber instead of starting a new one.

```ts
// Inside the layer — yield* to initialize the memo
let cached = yield * Effect.cached(loadExpensive())

const get = Effect.fn("Foo.get")(function* () {
  return yield* cached // concurrent callers share the same fiber
})

// To invalidate: swap in a fresh memo
const invalidate = Effect.fn("Foo.invalidate")(function* () {
  cached = yield* Effect.cached(loadExpensive())
})
```

Prefer `Effect.cached` over these patterns:

- Storing a `Fiber.Fiber | undefined` with manual check-and-fork (e.g. `file/index.ts` `ensure`)
- Storing a `Promise<void>` task for deduplication (e.g. `skill/index.ts` `ensure`)
- `let cached: X | undefined` with check-and-load (races when two callers see `undefined` before either resolves)

`Effect.cached` handles the run-once + concurrent-join semantics automatically. For invalidatable caches, reassign with `yield* Effect.cached(...)` — the old memo is discarded.

## Scheduled Tasks

For loops or periodic work, use `Effect.repeat` or `Effect.schedule` with `Effect.forkScoped` in the layer definition.

## Preferred Effect services

In effectified services, prefer yielding existing Effect services over dropping down to ad hoc platform APIs.

Prefer these first:

- `FileSystem.FileSystem` instead of raw `fs/promises` for effectful file I/O
- `ChildProcessSpawner.ChildProcessSpawner` with `ChildProcess.make(...)` instead of custom process wrappers
- `HttpClient.HttpClient` instead of raw `fetch`
- `Path.Path` instead of mixing path helpers into service code when you already need a path service
- `Config` for effect-native configuration reads
- `Clock` / `DateTime` for time reads inside effects

## Child processes

For child process work in services, yield `ChildProcessSpawner.ChildProcessSpawner` in the layer and use `ChildProcess.make(...)`.

Keep shelling-out code inside the service, not in callers.

## Shared leaf models

Shared schema or model files can stay outside the service namespace when lower layers also depend on them.

That is fine for leaf files like `schema.ts`. Keep the service surface in the owning namespace.

## Migration checklist

Fully migrated (single namespace, InstanceState where needed, flattened facade):

- [x] `Account` — `account/index.ts`
- [x] `Agent` — `agent/agent.ts`
- [x] `AppFileSystem` — `filesystem/index.ts`
- [x] `Auth` — `auth/index.ts` (uses `zod()` helper for Schema→Zod interop)
- [x] `Bus` — `bus/index.ts`
- [x] `Command` — `command/index.ts`
- [x] `Config` — `config/config.ts`
- [x] `Discovery` — `skill/discovery.ts` (dependency-only layer, no standalone runtime)
- [x] `File` — `file/index.ts`
- [x] `FileTime` — `file/time.ts`
- [x] `FileWatcher` — `file/watcher.ts`
- [x] `Format` — `format/index.ts`
- [x] `Installation` — `installation/index.ts`
- [x] `LSP` — `lsp/index.ts`
- [x] `MCP` — `mcp/index.ts`
- [x] `McpAuth` — `mcp/auth.ts`
- [x] `Permission` — `permission/index.ts`
- [x] `Plugin` — `plugin/index.ts`
- [x] `Project` — `project/project.ts`
- [x] `ProviderAuth` — `provider/auth.ts`
- [x] `Pty` — `pty/index.ts`
- [x] `Question` — `question/index.ts`
- [x] `SessionStatus` — `session/status.ts`
- [x] `Skill` — `skill/index.ts`
- [x] `Snapshot` — `snapshot/index.ts`
- [x] `ToolRegistry` — `tool/registry.ts`
- [x] `Truncate` — `tool/truncate.ts`
- [x] `Vcs` — `project/vcs.ts`
- [x] `Worktree` — `worktree/index.ts`

- [x] `Session` — `session/index.ts`
- [x] `SessionProcessor` — `session/processor.ts`
- [x] `SessionPrompt` — `session/prompt.ts`
- [x] `SessionCompaction` — `session/compaction.ts`
- [x] `SessionSummary` — `session/summary.ts`
- [x] `SessionRevert` — `session/revert.ts`
- [x] `Instruction` — `session/instruction.ts`
- [x] `SystemPrompt` — `session/system.ts`
- [x] `Provider` — `provider/provider.ts`
- [x] `Storage` — `storage/storage.ts`
- [x] `ShareNext` — `share/share-next.ts`

Still open:

- [x] `SessionTodo` — `session/todo.ts`
- [x] `SyncEvent` — `sync/index.ts`
- [x] `Workspace` — `control-plane/workspace.ts`

## Tool interface → Effect

`Tool.Def.execute` and `Tool.Info.init` already return `Effect` on this branch. Tool definitions should now stay Effect-native all the way through initialization instead of using Promise-returning init callbacks. Tools can still use lazy init callbacks when they need instance-bound state at init time, but those callbacks should return `Effect`, not `Promise`. Remaining work is:

1. Migrate each tool body to return Effects
2. Keep `Tool.define()` inputs Effect-native
3. Update remaining callers to `yield*` tool initialization instead of `await`ing

### Tool migration details

With `Tool.Info.init()` now effectful, use this transitional pattern for migrated tools that still need Promise-based boundaries internally:

- `Tool.defineEffect(...)` should `yield*` the services the tool depends on and close over them in the returned tool definition.
- Keep the bridge at the Promise boundary only inside the tool body when required by external APIs. Do not return Promise-based init callbacks from `Tool.define()`.
- If a tool starts requiring new services, wire them into `ToolRegistry.defaultLayer` so production callers resolve the same dependencies as tests.

Tool tests should use the existing Effect helpers in `packages/opencode/test/lib/effect.ts`:

- Use `testEffect(...)` / `it.live(...)` instead of creating fake local wrappers around effectful tools.
- Yield the real tool export, then initialize it: `const info = yield* ReadTool`, `const tool = yield* info.init()`.
- Run tests inside a real instance with `provideTmpdirInstance(...)` or `provideInstance(tmpdirScoped(...))` so instance-scoped services resolve exactly as they do in production.

This keeps migrated tool tests aligned with the production service graph today, and makes the eventual `Tool.Info` → `Effect` cleanup mostly mechanical later.

Individual tools, ordered by value:

- [x] `apply_patch.ts` — HIGH: multi-step orchestration, error accumulation, Bus events
- [ ] `bash.ts` — HIGH: shell orchestration, quoting, timeout handling, output capture
- [x] `read.ts` — HIGH: streaming I/O, readline, binary detection → FileSystem + Stream
- [ ] `edit.ts` — HIGH: multi-step diff/format/publish pipeline, FileWatcher lock
- [x] `grep.ts` — MEDIUM: spawns ripgrep → ChildProcessSpawner, timeout handling
- [ ] `write.ts` — MEDIUM: permission checks, diagnostics polling, Bus events
- [ ] `webfetch.ts` — MEDIUM: fetch with UA retry, size limits → HttpClient
- [ ] `websearch.ts` — MEDIUM: MCP over HTTP → HttpClient
- [ ] `batch.ts` — MEDIUM: parallel execution, per-call error recovery → Effect.all
- [ ] `task.ts` — MEDIUM: task state management
- [ ] `ls.ts` — MEDIUM: bounded directory listing over ripgrep-backed traversal
- [x] `glob.ts` — LOW: simple async generator
- [ ] `lsp.ts` — LOW: dispatch switch over LSP operations
- [ ] `question.ts` — LOW: prompt wrapper
- [ ] `skill.ts` — LOW: skill tool adapter
- [ ] `todo.ts` — LOW: todo persistence wrapper
- [ ] `invalid.ts` — LOW: invalid-tool fallback
- [ ] `plan.ts` — LOW: plan file operations

## Effect service adoption in already-migrated code

Some already-effectified areas still use raw `Filesystem.*` or `Process.spawn` in their implementation or helper modules. These are low-hanging fruit — the layers already exist, they just need the dependency swap.

### `Filesystem.*` → `AppFileSystem.Service` (yield in layer)

- [ ] `file/index.ts` — 1 remaining `Filesystem.readText()` call in untracked diff handling
- [ ] `config/config.ts` — 5 remaining `Filesystem.*` calls in `installDependencies()`
- [ ] `provider/provider.ts` — 1 remaining `Filesystem.readJson()` call for recent model state

### `Process.spawn` → `ChildProcessSpawner` (yield in layer)

- [ ] `format/formatter.ts` — 2 remaining `Process.spawn()` checks (`air`, `uv`)
- [ ] `lsp/server.ts` — multiple `Process.spawn()` installs/download helpers

## Filesystem consolidation

`util/filesystem.ts` (raw fs wrapper) is currently imported by **34 files**. The effectified `AppFileSystem` service (`filesystem/index.ts`) is currently imported by **15 files**. As services and tools are effectified, they should switch from `Filesystem.*` to yielding `AppFileSystem.Service` — this happens naturally during each migration, not as a separate effort.

Similarly, **21 files** still import raw `fs` or `fs/promises` directly. These should migrate to `AppFileSystem` or `Filesystem.*` as they're touched.

Current raw fs users that will convert during tool migration:

- `tool/read.ts` — fs.createReadStream, readline
- `file/ripgrep.ts` — fs/promises
- `patch/index.ts` — fs, fs/promises

## Primitives & utilities

- [ ] `util/lock.ts` — reader-writer lock → Effect Semaphore/Permit
- [ ] `util/flock.ts` — file-based distributed lock with heartbeat → Effect.repeat + addFinalizer
- [ ] `util/process.ts` — child process spawn wrapper → return Effect instead of Promise
- [ ] `util/lazy.ts` — replace uses in Effect code with Effect.cached; keep for sync-only code

## Destroying the facades

Every service currently exports async facade functions at the bottom of its namespace — `export async function read(...) { return runPromise(...) }` — backed by a per-service `makeRuntime`. These exist because cyclic imports used to force each service to build its own independent runtime. Now that the layer DAG is acyclic and `AppRuntime` (`src/effect/app-runtime.ts`) composes everything into one `ManagedRuntime`, we're removing them.

### Process

For each service, the migration is roughly:

1. **Find callers.** `grep -n "Namespace\.(methodA|methodB|...)"` across `src/` and `test/`. Skip the service file itself.
2. **Migrate production callers.** For each effectful caller that does `Effect.tryPromise(() => Namespace.method(...))`:
   - Add the service to the caller's layer R type (`Layer.Layer<Self, never, ... | Namespace.Service>`)
   - Yield it at the top of the layer: `const ns = yield* Namespace.Service`
   - Replace `Effect.tryPromise(() => Namespace.method(...))` with `yield* ns.method(...)` (or `ns.method(...).pipe(Effect.orElseSucceed(...))` for the common fallback case)
   - Add `Layer.provide(Namespace.defaultLayer)` to the caller's own `defaultLayer` chain
3. **Fix tests that used the caller's raw `.layer`.** Any test that composes `Caller.layer` (not `defaultLayer`) needs to also provide the newly-required service tag. The fastest fix is usually switching to `Caller.defaultLayer` since it now pulls in the new dependency.
4. **Migrate test callers of the facade.** Tests calling `Namespace.method(...)` directly get converted to full effectful style using `testEffect(Namespace.defaultLayer)` + `it.live` / `it.effect` + `yield* svc.method(...)`. Don't wrap the test body in `Effect.promise(async () => {...})` — do the whole thing in `Effect.gen` and use `AppFileSystem.Service` / `tmpdirScoped` / `Effect.addFinalizer` for what used to be raw `fs` / `Bun.write` / `try/finally`.
5. **Delete the facades.** Once `grep` shows zero callers, remove the `export async function` block AND the `makeRuntime(...)` line from the service namespace. Also remove the now-unused `import { makeRuntime }`.

### Pitfalls

- **Layer caching inside tests.** `testEffect(layer)` constructs the Storage (or whatever) service once and memoizes it. If a test then tries `inner.pipe(Effect.provide(customStorage))` to swap in a differently-configured Storage, the outer cached one wins and the inner provision is a no-op. Fix: wrap the overriding layer in `Layer.fresh(...)`, which forces a new instance to be built instead of hitting the memoMap cache. This lets a single `testEffect(...)` serve both simple and per-test-customized cases.
- **`Effect.tryPromise` → `yield*` drops the Promise layer.** The old code was `Effect.tryPromise(() => Storage.read(...))` — a `tryPromise` wrapper because the facade returned a Promise. The new code is `yield* storage.read(...)` directly — the service method already returns an Effect, so no wrapper is needed. Don't reach for `Effect.promise` or `Effect.tryPromise` during migration; if you're using them on a service method call, you're doing it wrong.
- **Raw `.layer` test callers break silently in the type checker.** When you add a new R requirement to a service's `.layer`, any test that composes it raw (not `defaultLayer`) becomes under-specified. `tsgo` will flag this — the error looks like `Type 'Storage.Service' is not assignable to type '... | Service | TestConsole'`. Usually the fix is to switch that composition to `defaultLayer`, or add `Layer.provide(NewDep.defaultLayer)` to the custom composition.
- **Tests that do async setup with `fs`, `Bun.write`, `tmpdir`.** Convert these to `AppFileSystem.Service` calls inside `Effect.gen`, and use `tmpdirScoped()` instead of `tmpdir()` so cleanup happens via the scope finalizer. For file operations on the actual filesystem (not via a service), a small helper like `const writeJson = Effect.fnUntraced(function* (file, value) { const fs = yield* AppFileSystem.Service; yield* fs.makeDirectory(path.dirname(file), { recursive: true }); yield* fs.writeFileString(file, JSON.stringify(value, null, 2)) })` keeps the migration tests clean.

### Migration log

- Workspace routing guardrails (completed 2026-05-30) as the next #936 slice after VCS, PTY connect-token, and SSE guardrails. This slice is planning + tests only; it does not migrate Hono routes to Effect HttpApi.
  - PR scope: lock the current workspace routing decisions before any middleware migration. `GET /session`, session-detail GET routes, and missing-workspace session deletes stay local while `/session/status` remains forwarded, a session's bound `workspaceID` wins over `?workspace=`, missing workspace records return an explicit `Workspace not found` error for normal routes, PawWork `/path?ensureConfig=true` must not create the legacy OpenCode config directory, and remote workspace WebSocket upgrades must reach `ServerProxy.websocket`.
  - Non-goals: no upstream `/sync/*`, workspace adapter/sync-list/warp, v2 `/api/*`, TUI, auth/OAuth, OpenAPI/SDK shape, or proxy internals migration.
  - Next follow-up: design the actual WorkspaceRouting / Effect instance context middleware split before replacing Hono middleware. Follow-ups only when touched: EnterWorktree/ExitWorktree execution-context tests and WebSocket queue/close-code/bidirectional proxy tests.

### Workspace routing / instance context planning

The future Effect middleware should preserve the existing Hono split rather than copying upstream semantics wholesale:

- `WorkspaceRouterMiddleware` is the router. It decides whether a request runs locally, forwards to a remote workspace, uses a local workspace target, or fails because the workspace record is missing.
- `InstanceMiddleware` is a thin provider for `/experimental/workspace`. It resolves the request directory and provides `Instance` / `WorkspaceContext`; it does not own proxy or forwarding decisions.
- The Effect design should bind request context through the existing bridge primitives: `InstanceRef`, `WorkspaceRef`, `attachWith`, `EffectBridge`, and the existing ALS-backed `Instance` / `WorkspaceContext`. Do not invent a parallel context model.
- Avoid naming the new provider simply `InstanceContext` unless the existing `project/instance-context.ts` type is intentionally overloaded; prefer a middleware-specific name in the implementation plan.

Decision table for the design:

| Case | Workspace routing decision | Context to provide |
| --- | --- | --- |
| No `workspace` and no session-bound workspace | Run in the request/default directory. Best-effort create `~/PawWork` when no directory is supplied. | `InstanceRef` for the resolved directory; no `WorkspaceRef`. |
| Local workspace target | Run in the adaptor target directory. | `InstanceRef` for target directory; `WorkspaceRef` for the selected workspace. |
| Remote workspace target, normal forwarded route | Forward through `ServerProxy.http` after stripping proxy-only workspace headers. | No local instance context for the route body. |
| Remote workspace target, WebSocket upgrade | Forward through `ServerProxy.websocket`. | No local instance context for the route body. |
| Remote workspace target, local cached route | Keep local for `GET /session` and session-detail GET routes, rather than forwarding them to the remote target. `GET /session` currently has no instance context and returns the current local error; making it return a usable list is a behavior change that needs an explicit decision. | No instance context today; preserve current route behavior unless explicitly changed. |
| `/session/status` with workspace | Forward to the remote target. | No local instance context for the route body. |
| Session route with a bound `workspaceID` and a conflicting query `workspace` | Use the session-bound workspace. | Same context as the selected workspace target. |
| Missing workspace record, normal route | Return `500` text response with `Workspace not found: <id>`. | No instance context. |
| Missing workspace record, `DELETE /session/:id` | Let the session route run so broken synced sessions remain deletable. | No instance context. |
| `/path?ensureConfig=true` in PawWork runtime | Return PawWork primary config path without creating the legacy OpenCode config directory. | Same context as the selected local path case. |

- `SessionStatus` — migrated 2026-04-11. Replaced the last route and retry-policy callers with `AppRuntime.runPromise(SessionStatus.Service.use(...))` and removed the `makeRuntime(...)` facade.
- `ShareNext` — migrated 2026-04-11. Swapped remaining async callers to `AppRuntime.runPromise(ShareNext.Service.use(...))`, removed the `makeRuntime(...)` facade, and kept instance bootstrap on the shared app runtime.
- `SessionTodo` — migrated 2026-04-10. Already matched the target service shape in `session/todo.ts`: single namespace, traced Effect methods, and no `makeRuntime(...)` facade remained; checklist updated to reflect the completed migration.
- `Storage` — migrated 2026-04-10. One production caller (`Session.diff`) and all storage.test.ts tests converted to effectful style. Facades and `makeRuntime` removed.
- `SessionRunState` — migrated 2026-04-11. Single caller in `server/routes/session.ts` converted; facade removed.
- `Account` — migrated 2026-04-11. Callers in `server/routes/experimental.ts` and `cli/cmd/account.ts` converted; facade removed.
- `Instruction` — migrated 2026-04-11. Test-only callers converted; facade removed.
- `FileTime` — migrated 2026-04-11. Test-only callers converted; facade removed.
- `FileWatcher` — migrated 2026-04-11. Callers in `project/bootstrap.ts` and test converted; facade removed.
- `Question` — migrated 2026-04-11. Callers in `server/routes/question.ts` and test converted; facade removed.
- `Truncate` — migrated 2026-04-11. Caller in `tool/tool.ts` and test converted; facade removed.
- `SyncEvent` — migrated 2026-06-14. Added `SyncEvent.Service` / `defaultLayer`, wired it into `AppRuntime`, and introduced typed `SyncEventError` failures for the Effect service path. Existing synchronous facade functions remain as the compatibility boundary for legacy callers.
- `Workspace` — migrated 2026-06-14. Added `Workspace.Service` / `defaultLayer`, wired it into `AppRuntime`, introduced typed `WorkspaceError` failures for the Effect service path, and moved workspace routing record/sync/adaptor resolution onto the injected service. Existing async facade functions remain as the compatibility boundary for legacy route/tests callers.
- `ApplyPatchTool` — migrated 2026-06-14. Tool body was already Effect-native; this follow-up moved `apply_patch.test.ts` off its local `ManagedRuntime` / Promise execute helper and onto the shared `testEffect(...).live` harness while preserving the defectified execute boundary coverage.
- `GrepTool` / `GlobTool` — migrated 2026-06-14. Tool bodies were already Effect-native; this follow-up moved `grep.test.ts` and `glob.test.ts` off local `ManagedRuntime` / Promise init helpers and onto the shared `testEffect(...).live` harness with scoped instance fixtures.

## Route handler effectification

Route handlers should wrap their entire body in a single `AppRuntime.runPromise(Effect.gen(...))` call, yielding services from context rather than calling facades one-by-one. This eliminates multiple `runPromise` round-trips and lets handlers compose naturally.

```ts
// Before — one facade call per service
;async (c) => {
  await SessionRunState.assertNotBusy(id)
  await Session.removeMessage({ sessionID: id, messageID })
  return c.json(true)
}

// After — one Effect.gen, yield services from context
;async (c) => {
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const state = yield* SessionRunState.Service
      const session = yield* Session.Service
      yield* state.assertNotBusy(id)
      yield* session.removeMessage({ sessionID: id, messageID })
    }),
  )
  return c.json(true)
}
```

When migrating, always use `{ concurrency: "unbounded" }` with `Effect.all` — route handlers should run independent service calls in parallel, not sequentially.

Route files to convert (each handler that calls facades should be wrapped):

- [ ] `server/routes/session.ts` — heaviest; uses Session, SessionPrompt, SessionRevert, SessionCompaction, SessionShare, SessionSummary, SessionRunState, Agent, Permission, Bus
- [ ] `server/routes/global.ts` — uses Config, Project, Provider, Vcs, Snapshot, Agent
- [ ] `server/routes/provider.ts` — uses Provider, Auth, Config
- [ ] `server/routes/question.ts` — uses Question
- [ ] `server/routes/pty.ts` — uses Pty
- [ ] `server/routes/experimental.ts` — uses Account, ToolRegistry, Agent, MCP, Config
