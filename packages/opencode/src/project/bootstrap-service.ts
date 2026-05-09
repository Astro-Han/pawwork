import { Context, Effect } from "effect"

export interface Interface {
  readonly run: Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceBootstrap") {}

export * as InstanceBootstrap from "./bootstrap-service"
