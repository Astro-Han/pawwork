import { Effect, Fiber } from "effect"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Instance, type InstanceContext } from "@/project/instance"
import type { WorkspaceID } from "@/control-plane/schema"
import { LocalContext } from "@/util/local-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { attachWith } from "./run-service"

export interface Shape {
  readonly promise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
}

function restore<R>(instance: InstanceContext | undefined, workspace: WorkspaceID | undefined, fn: () => R): R {
  // WorkspaceRef is reattached in Effect context via attachWith below.
  // Only Instance ALS needs synchronous restoration here for sync callers.
  if (instance && workspace !== undefined) return Instance.restore(instance, fn)
  if (instance) return Instance.restore(instance, fn)
  return fn()
}

export function make(): Effect.Effect<Shape> {
  return Effect.gen(function* () {
    const ctx = yield* Effect.context()
    const value = yield* InstanceRef
    const instance =
      value ??
      (() => {
        try {
          return Instance.current
        } catch (err) {
          if (!(err instanceof LocalContext.NotFound)) throw err
        }
      })()
    const workspace = (yield* WorkspaceRef) ?? (WorkspaceContext.workspaceID as WorkspaceID | undefined)
    const attach = <A, E, R>(effect: Effect.Effect<A, E, R>) => attachWith(effect, { instance, workspace })
    const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      attach(effect).pipe(Effect.provide(ctx)) as Effect.Effect<A, E, never>

    return {
      promise: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        restore(instance, workspace, () => Effect.runPromise(wrap(effect))),
      fork: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        restore(instance, workspace, () => Effect.runFork(wrap(effect))),
    } satisfies Shape
  })
}

export const EffectBridge = {
  make,
}
