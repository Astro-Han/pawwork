import { createBunWebSocket } from "hono/bun"
import { Hono } from "hono"
import type { Adapter } from "./adapter"

export const adapter: Adapter = {
  create(app) {
    const ws = createBunWebSocket()
    return {
      upgradeWebSocket(request, env, events) {
        const upgradeHost = new Hono()
        upgradeHost.all("*", (c) => ws.upgradeWebSocket(c, events as never))
        return upgradeHost.fetch(request, env as never)
      },
      async listen(opts) {
        const args = {
          fetch: app.fetch,
          hostname: opts.hostname,
          idleTimeout: 0,
          websocket: ws.websocket,
        } as const
        const start = (port: number) => {
          try {
            return Bun.serve({ ...args, port })
          } catch {
            return
          }
        }
        const server = opts.port === 0 ? (start(4096) ?? start(0)) : start(opts.port)
        if (!server) {
          throw new Error(`Failed to start server on port ${opts.port}`)
        }
        if (!server.port) {
          throw new Error(`Failed to resolve server address for port ${opts.port}`)
        }
        return {
          port: server.port,
          stop(close?: boolean) {
            return Promise.resolve(server.stop(close))
          },
        }
      },
    }
  },
}
