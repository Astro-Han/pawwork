export type Opts = {
  port: number
  hostname: string
}

export type Listener = {
  port: number
  stop: (close?: boolean) => Promise<void>
}

export type WebSocketContext<T = unknown> = {
  raw?: T
  readyState: number
  send(data: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
}

export type WebSocketEvents<T = unknown> = {
  onOpen?: (event: Event, ws: WebSocketContext<T>) => void
  onMessage?: (event: { data: string | Blob | ArrayBufferLike }, ws: WebSocketContext<T>) => void
  onClose?: (event: { code: number; reason: string }, ws: WebSocketContext<T>) => void
  onError?: (event: Event, ws: WebSocketContext<T>) => void
}

export type UpgradeWebSocket = (
  request: Request,
  env: unknown,
  events: WebSocketEvents,
) => Response | Promise<Response>

export interface Runtime {
  upgradeWebSocket: UpgradeWebSocket
  listen(opts: Opts): Promise<Listener>
}

export type FetchApp = {
  fetch: (request: Request, env?: unknown) => Response | Promise<Response>
}

export interface Adapter {
  create(app: FetchApp): Runtime
}
