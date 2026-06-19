import type { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"

export type Opts = {
  port: number
  hostname: string
}

export type Listener = {
  port: number
  stop: (close?: boolean) => Promise<void>
}

export interface Runtime {
  upgradeWebSocket: UpgradeWebSocket
  listen(opts: Opts): Promise<Listener>
}

export type FetchApp = {
  fetch: (request: Request, env?: unknown) => Response | Promise<Response>
}

export interface Adapter {
  create(app: FetchApp, websocketApp: Hono): Runtime
  create(app: Hono): Runtime
}
