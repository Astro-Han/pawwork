# Effect patterns

Practical reference for new and migrated Effect code in `packages/opencode`.

## Choose scope

Use `InstanceState` (from `src/effect/instance-state.ts`) for services that need per-directory state, per-instance cleanup, or project-bound background work. InstanceState uses a `ScopedCache` keyed by directory, so each open project gets its own copy of the state that is automatically cleaned up on disposal.

Use `makeRuntime` (from `src/effect/run-service.ts`) to create a per-service `ManagedRuntime` that lazily initializes and shares layers via a global `memoMap`. Returns `{ runPromise, runFork, runCallback }`.

- Global services (no per-directory state): Account, Auth, AppFileSystem, Installation, ModelState, Truncate, Worktree
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
- [x] `ModelsDev` — `provider/models.ts` (catalog cache and refresh use `Effect.cached`, `AppFileSystem.Service`, and `EffectFlock.Service`; async facade remains for callers)
- [x] `ModelState` — `provider/model-state.ts` (`recordRecent` write path; `Provider.defaultModel()` still owns the read path)
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

As of the tool-wrapper cleanup slice, `packages/opencode/src/tool/*.ts` no longer has plain `execute:` declarations in the inventory: each execute boundary is named with `Effect.fn(...)`. `tool/registry.ts` still contains compatibility adapters for plugin tools and `tool_info` availability injection, but those wrappers are also named Effect boundaries rather than Promise-returning tool definitions.

Individual tools, ordered by value:

- [x] `apply_patch.ts` — HIGH: multi-step orchestration, error accumulation, Bus events
- [x] `bash.ts` — HIGH: shell orchestration, quoting, timeout handling, output capture
- [x] `read.ts` — HIGH: streaming I/O, readline, binary detection → FileSystem + Stream
- [x] `edit.ts` — HIGH: multi-step diff/format/publish pipeline, FileWatcher lock
- [x] `grep.ts` — MEDIUM: spawns ripgrep → ChildProcessSpawner, timeout handling
- [x] `write.ts` — MEDIUM: permission checks, diagnostics polling, Bus events
- [x] `webfetch.ts` — MEDIUM: fetch with UA retry, size limits → HttpClient
- [x] `websearch.ts` — MEDIUM: MCP over HTTP → HttpClient
- [x] `glob.ts` — LOW: simple async generator
- [x] `lsp.ts` — LOW: dispatch switch over LSP operations
- [x] `question.ts` — LOW: prompt wrapper
- [x] `skill.ts` — LOW: skill tool adapter
- [x] `todo.ts` — LOW: todo persistence wrapper
- [x] `invalid.ts` — LOW: invalid-tool fallback
- [x] `plan.ts` — LOW: plan file operations

Stale entries removed 2026-06-19: the current tree has no `tool/batch.ts`, `tool/task.ts`, or `tool/ls.ts` files.

## Effect service adoption in already-migrated code

Some already-effectified areas still use raw `Filesystem.*` or `Process.spawn` in their implementation or helper modules. These are low-hanging fruit — the layers already exist, they just need the dependency swap.

### `Filesystem.*` → `AppFileSystem.Service` (yield in layer)

- [x] `file/index.ts` — current tree has no remaining `Filesystem.*` calls; untracked diff handling reads through `AppFileSystem.Service`
- [x] `config/config.ts` — `installDependencies()` now lives on `Config.Service`, uses `AppFileSystem.Service` and `EffectFlock`, and the async facade delegates through `runPromise`
- [x] `provider/provider.ts` — default model state reads through `AppFileSystem.Service`; no remaining `Filesystem.*` calls in the current file
- [x] `provider/models.ts` — catalog cache reads, TTL checks, and atomic writes now run through `AppFileSystem.Service`

### `Process.spawn` → `ChildProcessSpawner` (yield in layer)

- [x] `format/formatter.ts` — formatter discovery now uses `AppFileSystem.Service` and `ChildProcessSpawner`
- [x] `lsp/server.ts` — install/download/root helper IO now uses named Effect helpers backed by `AppFileSystem.Service` and `ChildProcessSpawner`; `launch.ts` remains the long-lived LSP process compatibility launcher

## Filesystem consolidation

`util/filesystem.ts` (raw fs wrapper) still has direct callers, while the effectified `AppFileSystem` service (`filesystem/index.ts`) is now used across migrated service and tool owners. As services and tools are effectified, they should switch from `Filesystem.*` to yielding `AppFileSystem.Service` — this happens naturally during each migration, not as a separate effort.

Similarly, **21 files** still import raw `fs` or `fs/promises` directly. These should migrate to `AppFileSystem` or `Filesystem.*` as they're touched.

Current raw fs users that will convert during tool migration:

- `tool/read.ts` — fs.createReadStream, readline
- `file/ripgrep.ts` — fs/promises
- `patch/index.ts` — fs, fs/promises

## Primitives & utilities

- [x] `util/lock.ts` — removed; no production callers remained, and the only direct references were the util export plus `test/util/lock.test.ts`
- [ ] `util/flock.ts` — `packages/core/src/util/effect-flock.ts` is the Effect-native implementation; Effect/service callers should use `EffectFlock.Service`, while legacy Promise callers still use the `packages/opencode/src/util/flock.ts` facade
  - Converted in this slice: provider models catalog refresh, `Config.withConfigFileLock`, plugin config patching, and plugin metadata reads now run their critical sections through `EffectFlock.Service`
  - Retained Promise lease boundary: automation run leases/scheduler ownership and direct flock compatibility tests still need the legacy lease object facade
  - Guardrail: `test/effect/legacy-boundaries.test.ts` prevents new production imports of `@/util/flock` outside the automation lease owners and rejects production `EffectFlock.withLockPromise` usage
- [x] `util/process.ts` — `Process.Service` and Effect-native `run/text/lines/stop/descendants/terminateTree` now own execution and cleanup; the async facade delegates through `runPromise`
  - Retained compatibility boundary: `Process.spawn` still returns the Node child facade because CLI pager/auth flows, long-lived LSP launch, Windows cmd script spawning, and stream ownership still depend on that shape
  - Converted in this slice: `session/prompt.ts` inline shell expansion, `pty/index.ts` teardown cleanup, and `tool/shell.ts` abort/timeout cleanup use `Process.*Effect` directly
- [ ] `util/lazy.ts` — sync-only route factories, shell selection, native module loading, and zod recursion stay on `lazy`; async Effect code should use `Effect.cached`
  - Converted in this slice: provider models catalog cache now uses `Effect.cached` inside `ModelsDev.Service`; `tool/shell.ts` parser initialization also uses `Effect.cached` inside the tool's Effect definition
  - Converted in this slice: control-plane built-in workspace adaptors now use a static map, and `WorktreeAdaptor` calls `Worktree.Service` through the service runtime instead of the `Worktree` Promise facade
  - Guardrail: `test/effect/legacy-boundaries.test.ts` rejects async `lazy` in production source and keeps the worktree adaptor off the Promise facade path

## Destroying the facades

Every service currently exports async facade functions at the bottom of its namespace — `export async function read(...) { return runPromise(...) }` — backed by a per-service `makeRuntime`. These exist because cyclic imports used to force each service to build its own independent runtime. Now that the layer DAG is acyclic and `AppRuntime` (`src/effect/app-runtime.ts`) composes everything into one `ManagedRuntime`, we're removing them.

### Process

Process execution is now effect-native at the utility boundary. Keep the Node child `spawn` facade until long-lived process owners no longer need direct `stdin`/`stdout` streams and `exited` promises, then delete it as a separate compatibility cleanup.

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
- `WebFetchTool` / `WebSearchTool` — migrated 2026-06-15. Tool bodies were already Effect-native and backed by `HttpClient`; this follow-up moved `webfetch.test.ts` and `websearch.test.ts` onto the shared `testEffect(...).live` harness while preserving the fake HTTP server/client behavior and existing assertion semantics.
- `WriteTool` / `EditTool` / `LspTool` — checklist corrected 2026-06-15. Tool bodies already used named `Effect.fn(...execute)` boundaries and the shared `testEffect(...).live` harness; this follow-up verified the existing write/edit/lsp coverage and closed the stale checklist without code or test changes.
- `ShellTool` / public `bash` tool — migrated 2026-06-15. The current tree exposes this tool from `tool/shell.ts` with public tool id `bash`; there is no standalone `bash.ts` file. The tool body already used named `Effect.fn(...)` boundaries, and this follow-up moved `shell.test.ts` off its local `ManagedRuntime` / `runtime.runPromise(...)` helper and onto an explicit `Effect.provide(testLayer)` runner that initializes and executes the tool inside the same Effect scope while preserving the shell behavior matrix.
- `SkillTool` — migrated 2026-06-15. The tool body already used the named `Effect.fn("SkillTool.execute")` boundary; this follow-up moved the remaining `skill.test.ts` execute coverage off its local `ManagedRuntime` / `runtime.runPromise(...)` helper and onto an inline `Effect.scoped` + `Effect.provide(testLayer)` boundary, without changing skill discovery or ToolRegistry behavior.
- Low-tail tools — migrated 2026-06-19. `QuestionTool`, `TodoWriteTool`, and `InvalidTool` already used `Tool.define(...)`, effectful init, and named `Effect.fn(...execute)` boundaries; this follow-up added shared Effect-harness execute coverage for submitted question answers, Todo.Service-backed persistence, and the invalid-tool fallback shape. `PlanExitTool` now wraps its `MessageV2.stream(...)` model lookup in a named Effect boundary and uses `Clock.currentTimeMillis` for the synthetic build-agent message timestamp, with coverage for the approved plan-exit handoff. No HTTP/server, remote, UI, or registry behavior changed.
- Browser tool tests / `Tool.define` wrapper tests — migrated 2026-06-15. Browser tool bodies were already `Tool.define` + named `Effect.fn(...execute)` definitions, and `browser-shared.ts` already wrapped the CDP Promise boundary with `Effect.tryPromise`; this follow-up moved `browser-tools.test.ts` and `tool-define.test.ts` off their local `Effect.runPromise` / `ManagedRuntime` helpers and onto the shared `testEffect(...).live` harness while preserving fake CDP, permission, cancellation, and wrapper error-boundary assertions.
- Light instance route handlers — migrated 2026-06-15. The `server/instance/permission.ts` e2e ask and list/prune handlers, `server/instance/session.ts` status and todo handlers, `server/instance/index.ts` raw/apply VCS handlers, and `server/instance/global.ts` upgrade handler now run their bodies through one `AppRuntime.runPromise(Effect.gen(...))` service injection path while preserving fire-and-forget logging, dangling-session pruning, VCS error mappings, and upgrade result handling. This does not claim full session, global, or heavy route migration.
- MCP route handlers — migrated 2026-06-15. The current `server/instance/mcp.ts` operation handlers now run MCP service calls through `AppRuntime.runPromise(Effect.gen(...))` and `MCP.Service`, with route tests covering disabled local server add and non-OAuth auth 400 behavior. This does not change MCP service behavior, OAuth providers, or config schema.
- Workspace route handlers — migrated 2026-06-15. The current `server/instance/workspace.ts` create/list/status/remove handlers now run through `AppRuntime.runPromise(Effect.gen(...))` and `Workspace.Service`, with route tests covering the public create/list/status/remove HTTP behavior, current-project status filtering, and legacy worktree bad-request error mapping.
- Server routing/runtime helpers — migrated 2026-06-15. `server/proxy.ts` and `server/fence.ts` now read workspace connection status through `AppRuntime` and `Workspace.Service`, while `server/instance/workspace-routing.ts` resolves session-bound workspace ownership through the injected `Session.Service`. This keeps Hono routing behavior unchanged and leaves the service facades as legacy compatibility boundaries.
- Session route facade stragglers — migrated 2026-06-15. The current `server/instance/session.ts` owner now routes the listed GET `/session`, share/unshare session fetches, summarize post-loop message check, and deprecated session permission response through `AppRuntime.runPromise(Effect.gen(...))` with `Session.Service` / `Permission.Service`. This only clears those route-owner stragglers; it does not claim full `server/routes/session.ts` migration and does not touch session processor, prompt, or run-state internals.
- Session route service block — migrated 2026-06-15. The current `server/instance/session.ts` owner now routes session create/share/unshare, abort, init/command/shell/prompt/prompt_async/summarize loop, and revert/unrevert through `AppRuntime.runPromise(Effect.gen(...))` with `SessionShare.Service`, `SessionPrompt.Service`, and `SessionRevert.Service`. Route tests no longer spy on the legacy facades, and HTTP prompt routes still strip client-supplied `automationID`. The synchronous `MessageV2.get` route call remains direct because `MessageV2` has no suitable Effect service boundary in this file.
- Experimental route boundary — migrated 2026-06-15. The current `server/instance/experimental.ts` owner now routes Console state/org switch, tool ids/list, worktree create/list/remove/reset, and MCP resources through named `Effect.fn(...)` route boundaries that yield `Config.Service`, `Account.Service`, `ToolRegistry.Service`, `Agent.Service`, `Worktree.Service`, and `MCP.Service`. The `/experimental/session` list route intentionally remains on the existing `Session.listGlobal(...)` async iterator because migrating it would broaden the slice into Session pagination/cursor internals.
- Instance root route boundary — migrated 2026-06-18. The current `server/instance/index.ts` owner now routes instance dispose, path metadata, root VCS JSON/diff/status/raw/apply, command list, agent list, skill list, and LSP status through named `Effect.fn(...)` route boundaries with one shared `AppRuntime.runPromise` bridge. VCS handlers still yield `Vcs.Service` and preserve raw/apply error mappings; `/instance/dispose` intentionally keeps the existing `Instance.dispose()` compatibility facade inside the Effect boundary because it updates legacy instance directory bookkeeping that is not exposed as an Effect service API.
- Small instance route owners — migrated 2026-06-18. `server/instance/file.ts`, `server/instance/project.ts`, `server/instance/memory.ts`, and `server/instance/external-result.ts` now route body work through named `Effect.fn(...)` boundaries with one route-local `AppRuntime.runPromise` bridge per owner. File/project/external-result routes yield `Ripgrep.Service`, `File.Service`, `Project.Service`, and `Session.Service` where service APIs already exist. Project init still keeps the existing `Instance.reload(...)` compatibility call inside the route effect, memory still wraps the existing `MemoryService` Promise API, and external-result still uses `MessageV2.get(...)` inside the route effect because those behaviors do not yet have suitable service APIs in this slice.
- Global/workspace/permission/automation route boundary — migrated 2026-06-18. The current `server/instance/global.ts`, `workspace.ts`, `permission.ts`, and `automation.ts` owners now route their non-streaming service work through named `Effect.fn(...)` boundaries and shared route-local AppRuntime bridges. Global config/dispose/upgrade, workspace create/list/status/remove, permission e2e ask/reply/list, and automation list/create/get/update/pause/resume/delete/run/runs preserve their existing HTTP shapes; automation intentionally keeps its `runPromiseExit` typed error mapper so `ValidationError`, `ConflictError`, and `ActiveRunStillRunningError` still map to the same `422`/`409` responses. Global health and SSE routes stay direct because they do not cross a service runtime boundary.
- Session route boundary — migrated 2026-06-18. The current `server/instance/session.ts` owner now routes its service-backed session CRUD, todo, share/unshare, export, diff, turn-change, artifacts, summarize, messages, message/part mutation, command/shell, revert/unrevert, and deprecated permission reply work through named `Effect.fn(...)` boundaries plus one route-local AppRuntime bridge. Streaming prompt and fire-and-forget prompt_async keep the existing Hono stream/error behavior through `runHttpPrompt`, while synchronous `MessageV2.get(...)` and the tool/respond lookup/decoder stay as route compatibility code because they do not have a suitable service boundary in this slice.
- LSP server helper IO — migrated 2026-06-19. `packages/opencode/src/lsp/server.ts` now keeps root discovery, installer filesystem work, archive cleanup, chmod/symlink/rename, and short-lived install/build commands behind named Effect helpers. The public `LSPServer.Info.spawn(root): Promise<Handle | undefined>` shape remains as the compatibility facade, and `packages/opencode/src/lsp/launch.ts` still owns long-lived language-server process spawning.
- Special HTTP production boundary — migrated 2026-06-19. `server.ts` no longer mounts the catch-all Hono compatibility app for production fallback. `GET /event`, `GET /global/event`, `GET /global/sync-event`, and `ALL /*` UI static/proxy now run through native Web `Request`/`Response` handlers. `GET /pty/:ptyID/connect` and `GET /__workspace_ws` remain in the explicit `server/websocket-compatibility.ts` island because the Node adapter still exposes Hono's `upgradeWebSocket` API for real WebSocket upgrades.

## Route handler effectification

Route handlers should keep effectful service work behind named `Effect.fn(...)` route boundaries and run each handler through one AppRuntime bridge, yielding services from context rather than calling facades one-by-one. This eliminates multiple `runPromise` round-trips and gives route effects stable trace names.

```ts
// Before — one facade call per service
;async (c) => {
  await SessionRunState.assertNotBusy(id)
  await Session.removeMessage({ sessionID: id, messageID })
  return c.json(true)
}

// After — one named route effect, yield services from context
const removeMessage = Effect.fn("SessionRoutes.message.remove")(function* (id, messageID) {
  const state = yield* SessionRunState.Service
  const session = yield* Session.Service
  yield* state.assertNotBusy(id)
  yield* session.removeMessage({ sessionID: id, messageID })
})

;async (c) => {
  await AppRuntime.runPromise(removeMessage(id, messageID))
  return c.json(true)
}
```

When migrating, always use `{ concurrency: "unbounded" }` with `Effect.all` — route handlers should run independent service calls in parallel, not sequentially.

Route files to convert (each handler that calls facades should be wrapped):

- [x] `server/instance/session.ts` — migrated 2026-06-18. Service-backed session CRUD, todo, share/unshare, export, diff, turn-change, artifacts, summarize, messages, message/part mutation, command/shell, revert/unrevert, and deprecated permission reply handlers now use named route effects plus one shared AppRuntime bridge; streaming prompt/prompt_async, synchronous `MessageV2.get(...)`, and tool/respond lookup/decoder remain compatibility boundaries by design.
- [x] `server/instance/global.ts` — migrated 2026-06-18. Config, dispose, and upgrade service work now uses named route effects plus a shared AppRuntime bridge; health and SSE routes remain direct by design.
- [x] `server/instance/index.ts` — migrated 2026-06-18. Root instance, path, VCS, command, agent, skill, and LSP handlers now use named route effects plus a shared AppRuntime bridge; `/instance/dispose` keeps `Instance.dispose()` inside the Effect boundary for legacy directory bookkeeping.
- [x] `server/instance/provider.ts` — migrated 2026-06-15. Provider auth route bodies now yield `ProviderAuth.Service` inside `AppRuntime.runPromise(Effect.gen(...))`; the old `server/routes/provider.ts` checklist path is stale in the current tree.
- [ ] `server/routes/question.ts` — stale checklist path. The current tree has no `server/instance/question.ts` route; do not claim completion without a live route owner.
- [x] `server/instance/pty.ts` — migrated 2026-06-15. Connect-token and WebSocket connect route bodies now yield `Pty.Service` for target lookup and connection setup; the old `server/routes/pty.ts` checklist path is stale in the current tree.
- [x] `server/instance/workspace.ts` — migrated 2026-06-18. Workspace create/list/status/remove handlers now use named route effects plus a shared AppRuntime bridge; status still lists the current project first and filters global workspace statuses by those ids.
- [x] `server/instance/permission.ts` — migrated 2026-06-18. E2E ask, reply, and list/prune handlers now use named route effects plus a shared AppRuntime bridge while preserving fire-and-forget logging for the e2e seed route.
- [x] `server/instance/automation.ts` — migrated 2026-06-18. Automation handlers now use named route effects while preserving the route-local `runPromiseExit` error mapper for typed validation/conflict/active-run HTTP responses.
- [x] `server/instance/experimental.ts` — migrated 2026-06-15 for Console, tool, worktree, and MCP resource handlers. The old `server/routes/experimental.ts` checklist path is stale in the current tree. `/experimental/session` still calls `Session.listGlobal(...)` directly by design.
- [x] `server/instance/file.ts` — migrated 2026-06-18. Find/list/read/status handlers now use named route effects and yield `Ripgrep.Service` / `File.Service` through one route-local runtime bridge.
- [x] `server/instance/project.ts` — migrated 2026-06-18. List/init-git/update handlers now use named route effects and yield `Project.Service`; init-git keeps `Instance.reload(...)` inside the route effect for legacy instance bookkeeping.
- [x] `server/instance/memory.ts` — migrated 2026-06-18. Memory read/update/reset/disabled/delete handlers now use named route effects and one route-local runtime bridge around the existing `MemoryService` Promise API.
- [x] `server/instance/external-result.ts` — migrated 2026-06-18. Pending external-result hydration now runs through one route effect, yielding `Session.Service` once and preserving stale-entry skip/retry behavior while keeping `MessageV2.get(...)` inside the effect because there is no suitable MessageV2 service boundary here.
