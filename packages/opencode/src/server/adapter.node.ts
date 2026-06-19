import { createAdaptorServer, type ServerType } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import type { Hono } from "hono"
import type { Socket } from "node:net"
import type { Adapter } from "./adapter"

export const adapter: Adapter = {
  create(app, websocketApp?: Hono) {
    const ws = createNodeWebSocket({ app: websocketApp ?? (app as Hono) })
    return {
      upgradeWebSocket: ws.upgradeWebSocket,
      async listen(opts) {
        const start = (port: number) =>
          new Promise<ServerType>((resolve, reject) => {
            const server = createAdaptorServer({ fetch: app.fetch })
            ws.injectWebSocket(server)
            const fail = (err: Error) => {
              cleanup()
              reject(err)
            }
            const ready = () => {
              cleanup()
              resolve(server)
            }
            const cleanup = () => {
              server.off("error", fail)
              server.off("listening", ready)
            }
            server.once("error", fail)
            server.once("listening", ready)
            server.listen(port, opts.hostname)
          })

        const server = opts.port === 0 ? await start(4096).catch(() => start(0)) : await start(opts.port)
        const upgradedSockets = new Set<Socket>()
        server.on("upgrade", (_request, socket) => {
          upgradedSockets.add(socket)
          socket.once("close", () => upgradedSockets.delete(socket))
        })
        const addr = server.address()
        if (!addr || typeof addr === "string") {
          throw new Error(`Failed to resolve server address for port ${opts.port}`)
        }

        let closing: Promise<void> | undefined
        return {
          port: addr.port,
          stop(close?: boolean) {
            closing ??= (async () => {
              if (close) {
                for (const socket of upgradedSockets) {
                  socket.destroy()
                }
              }
              const webSocketClosed = new Promise<void>((resolve, reject) => {
                ws.wss.close((err) => {
                  if (err) reject(err)
                  else resolve()
                })
              })
              const serverClosed = new Promise<void>((resolve, reject) => {
                server.close((err) => {
                  if (err) reject(err)
                  else resolve()
                })
              })
              if (close) {
                if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
                  server.closeAllConnections()
                }
                if ("closeIdleConnections" in server && typeof server.closeIdleConnections === "function") {
                  server.closeIdleConnections()
                }
              }
              await Promise.all([serverClosed, webSocketClosed])
            })()
            return closing
          },
        }
      },
    }
  },
}
