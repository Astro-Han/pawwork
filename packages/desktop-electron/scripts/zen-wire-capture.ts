/**
 * Record what PawWork actually puts on the wire to the OpenCode Zen gateway.
 *
 * The identity and session headers this product sends are assembled across
 * three layers it does not own end to end — the pi-ai adapter patch, the
 * product patch, and the fetch preload — and each layer can be read correctly
 * while the bytes leaving the process are still wrong. Reading the sources, or
 * instrumenting the preload, only proves what we intended to send.
 *
 * So this terminates TLS for `opencode.ai` with a throwaway CA and reports the
 * request head verbatim. The app keeps fetching `https://opencode.ai/...`:
 * pointing it at a local recorder instead would make `isOpenCodeZenUrl` answer
 * false, skip the preload, and measure traffic no user ever sends.
 *
 * Every other host is tunnelled untouched, and the CA lives in a temporary
 * directory that goes away with the process.
 *
 * Usage:
 *   pnpm exec tsx scripts/zen-wire-capture.ts
 * then start the app with the environment it prints, exercise the models, and
 * stop the recorder with Ctrl-C for the summary.
 */
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { connect as netConnect, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createTlsServer, connect as tlsConnect } from "node:tls"

const TARGET = "opencode.ai"
const PORT = Number(process.env.ZEN_WIRE_PORT ?? 49780)

// RFC 9110 field-name token and field-value: a header the gateway would reject
// as malformed is a defect this tool has to name, not quietly print.
const FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FIELD_VALUE = /^[\x21-\x7E]([\x20\x09\x21-\x7E]*[\x21-\x7E])?$/

type Capture = {
  readonly at: string
  readonly requestLine: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly model?: string
}

/**
 * The model the gateway was actually asked for, read off the body rather than
 * off whatever the caller believed it requested. A verification run that only
 * checks its own intent cannot tell a per-model sweep apart from the same model
 * answering every time.
 */
const MODEL_FIELD = /"model"\s*:\s*"([^"]+)"/
const MODEL_SCAN_BYTES = 4096

const captures: Capture[] = []
/** Connections whose framing this parser cannot follow, so their later requests went unchecked. */
let unframed = 0
const workDir = mkdtempSync(join(tmpdir(), "pawwork-zen-wire-"))
const capturePath = join(workDir, "capture.jsonl")

function issueCertificate() {
  const ca = join(workDir, "ca-cert.pem")
  const caKey = join(workDir, "ca-key.pem")
  const leaf = join(workDir, "leaf-cert.pem")
  const leafKey = join(workDir, "leaf-key.pem")
  const csr = join(workDir, "leaf.csr")
  const ext = join(workDir, "ext.cnf")
  writeFileSync(ext, `subjectAltName=DNS:${TARGET}\n`)

  const openssl = (args: string[]) => {
    try {
      execFileSync("openssl", args, { stdio: "pipe" })
    } catch (error) {
      throw new Error(
        `openssl is required to mint the throwaway CA: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-keyout", caKey, "-out", ca, "-days", "1", "-nodes", "-subj", "/CN=PawWork Zen Wire Capture"])
  openssl(["req", "-newkey", "rsa:2048", "-keyout", leafKey, "-out", csr, "-nodes", "-subj", `/CN=${TARGET}`])
  openssl(["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", leaf, "-days", "1", "-extfile", ext])

  return { ca, cert: readFileSync(leaf), key: readFileSync(leafKey) }
}

const { ca, cert, key } = issueCertificate()

function record(head: string, model: string | undefined) {
  const [requestLine, ...fields] = head.split("\r\n").filter((line) => line.length > 0)
  const headers = fields.map((line) => {
    const colon = line.indexOf(":")
    return [line.slice(0, colon), line.slice(colon + 1).trim()] as const
  })
  const capture: Capture = {
    at: new Date().toISOString(),
    requestLine: requestLine ?? "",
    headers,
    ...(model === undefined ? {} : { model }),
  }
  captures.push(capture)
  appendFileSync(capturePath, `${JSON.stringify(capture)}\n`)
}

const tlsServer = createTlsServer({ cert, key }, (client) => {
  // A write on a still-connecting socket is queued, so writing chunks straight
  // through would put body bytes ahead of the head and the origin answers 400.
  let connected = false
  const pending: Buffer[] = []
  const upstream = tlsConnect({ host: TARGET, port: 443, servername: TARGET }, () => {
    connected = true
    for (const queued of pending.splice(0)) if (queued.length > 0) upstream.write(queued)
  })
  upstream.on("error", () => client.destroy())
  upstream.pipe(client)

  // One tunnel carries many requests, so the stream is parsed continuously
  // rather than only as far as the first blank line. Bodies are stepped over by
  // Content-Length, because a body containing a blank line would otherwise be
  // read as the next request head.
  let buffer = Buffer.alloc(0)
  let head: string | undefined
  let bodyRemaining = 0
  let scan = Buffer.alloc(0)
  let framed = true

  const flush = () => {
    if (head === undefined) return
    record(head, MODEL_FIELD.exec(scan.toString("utf8"))?.[1])
    head = undefined
    scan = Buffer.alloc(0)
  }

  client.on("data", (chunk: Buffer) => {
    if (connected) upstream.write(chunk)
    else pending.push(chunk)
    if (!framed) return

    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (bodyRemaining > 0) {
        const take = Math.min(bodyRemaining, buffer.length)
        if (scan.length < MODEL_SCAN_BYTES) {
          scan = Buffer.concat([scan, buffer.subarray(0, Math.min(take, MODEL_SCAN_BYTES - scan.length))])
        }
        buffer = buffer.subarray(take)
        bodyRemaining -= take
        if (bodyRemaining > 0) return
        flush()
        continue
      }
      const end = buffer.indexOf("\r\n\r\n")
      if (end === -1) return
      head = buffer.subarray(0, end + 4).toString("latin1")
      buffer = buffer.subarray(end + 4)
      // Only Content-Length framing can be stepped over exactly. Anything else
      // desynchronises the parser, so recording stops and the summary says so
      // rather than reporting heads it may have invented.
      if (/^transfer-encoding:/im.test(head)) {
        flush()
        framed = false
        unframed += 1
        return
      }
      bodyRemaining = Number(/^content-length:[ \t]*(\d+)/im.exec(head)?.[1] ?? 0)
      if (bodyRemaining === 0) flush()
    }
  })
  // A request cut off mid-body still had a head worth checking.
  client.on("end", flush)
  client.on("error", () => upstream.destroy())
})

const proxy = createServer((_request, response) => {
  response.writeHead(405).end("CONNECT only")
})

proxy.on("connect", (request, socket: Socket, head: Buffer) => {
  const [host, port = "443"] = (request.url ?? "").split(":")
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")

  if (host !== TARGET) {
    const passthrough = netConnect(Number(port), host, () => {
      if (head.length > 0) passthrough.write(head)
      socket.pipe(passthrough).pipe(socket)
    })
    passthrough.on("error", () => socket.destroy())
    socket.on("error", () => passthrough.destroy())
    return
  }

  tlsServer.emit("connection", socket)
  if (head.length > 0) socket.unshift(head)
})

/** Report each intercepted path, and every way its head could be wrong. */
function summarize() {
  if (captures.length === 0) {
    process.stdout.write("\nNo Zen requests were intercepted.\n")
    return
  }
  process.stdout.write(`\n${captures.length} Zen requests, recorded in ${capturePath}\n`)

  const paths = new Map<string, Capture[]>()
  for (const capture of captures) {
    const path = capture.requestLine.split(" ")[1] ?? capture.requestLine
    paths.set(path, [...(paths.get(path) ?? []), capture])
  }

  let failed = false
  for (const [path, group] of paths) {
    const problems: string[] = []
    const sessions = new Set<string>()
    const models = new Set<string>()
    for (const capture of group) {
      if (capture.model !== undefined) models.add(capture.model)
      const fields = new Map(capture.headers.map(([name, value]) => [name.toLowerCase(), value]))
      const session = fields.get("x-opencode-session")
      // The model list carries no conversation, so it is the one path allowed to omit it.
      if (session === undefined) {
        if (!path.endsWith("/models")) problems.push("no x-opencode-session")
      } else {
        sessions.add(session)
        if (session !== fields.get("x-client-request-id")) problems.push("session id does not match x-client-request-id")
      }
      const names = capture.headers.map(([name]) => name.toLowerCase())
      const duplicate = names.find((name, index) => names.indexOf(name) !== index)
      if (duplicate !== undefined) problems.push(`duplicate field ${duplicate}`)
      for (const [name, value] of capture.headers) {
        if (!FIELD_NAME.test(name)) problems.push(`malformed field name ${JSON.stringify(name)}`)
        if (!FIELD_VALUE.test(value)) problems.push(`malformed value for ${name}`)
      }
    }
    const unique = [...new Set(problems)]
    failed ||= unique.length > 0
    process.stdout.write(
      `  ${path}: ${group.length} requests, ${sessions.size} session id(s)` +
        `${unique.length === 0 ? ", head OK" : `, PROBLEMS: ${unique.join("; ")}`}\n` +
        (models.size === 0 ? "" : `    models served: ${[...models].sort().join(", ")}\n`),
    )
  }
  // The point of the tool is completeness, so an incomplete run fails rather
  // than reporting OK over the requests it could not read.
  if (unframed > 0) {
    process.stdout.write(`  PROBLEMS: ${unframed} connection(s) used framing this parser cannot follow\n`)
    failed = true
  }
  if (failed) process.exitCode = 1
}

function shutdown() {
  summarize()
  // The capture is the point of running this, so it outlives the process; the
  // key material does not.
  for (const secret of ["ca-key.pem", "leaf-key.pem", "leaf.csr"]) {
    rmSync(join(workDir, secret), { force: true })
  }
  process.exit(process.exitCode ?? 0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

proxy.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `Recording ${TARGET} on 127.0.0.1:${PORT}. Start the app with:\n\n` +
      `  NODE_OPTIONS=--use-env-proxy \\\n` +
      `  HTTPS_PROXY=http://127.0.0.1:${PORT} \\\n` +
      `  NODE_EXTRA_CA_CERTS=${ca}\n\n` +
      `--use-env-proxy is what makes the sidecar's fetch honour the proxy; it needs Node 24+,\n` +
      `which Electron 41 provides. Ctrl-C for the summary.\n`,
  )
})
