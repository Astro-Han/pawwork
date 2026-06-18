import { PtyID } from "@/pty/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, NotFoundError } from "./common"

const root = "/pty"

const PtyParam = Schema.Struct({
  ptyID: PtyID,
})

const PtyInfo = Schema.Struct({
  id: PtyID,
  title: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  status: Schema.Literals(["running", "exited"]),
  pid: Schema.Number,
})

const PtyCreateInput = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

const PtyUpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  size: Schema.optional(
    Schema.Struct({
      rows: Schema.Number,
      cols: Schema.Number,
    }),
  ),
})

const ConnectToken = Schema.Struct({
  ticket: Schema.String,
  expires_in: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
})

export const PtyApi = HttpApi.make("pty")
  .add(
    HttpApiGroup.make("pty")
      .add(
        HttpApiEndpoint.get("list", root, {
          success: Schema.Array(PtyInfo),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.list",
            summary: "List PTY sessions",
            description: "Get a list of all active pseudo-terminal (PTY) sessions managed by OpenCode.",
          }),
        ),
        HttpApiEndpoint.post("create", root, {
          payload: PtyCreateInput,
          success: PtyInfo,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.create",
            summary: "Create PTY session",
            description: "Create a new pseudo-terminal (PTY) session for running shell commands and processes.",
          }),
        ),
        HttpApiEndpoint.get("get", `${root}/:ptyID`, {
          params: PtyParam,
          success: PtyInfo,
          error: NotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.get",
            summary: "Get PTY session",
            description: "Retrieve detailed information about a specific pseudo-terminal (PTY) session.",
          }),
        ),
        HttpApiEndpoint.put("update", `${root}/:ptyID`, {
          params: PtyParam,
          payload: PtyUpdateInput,
          success: PtyInfo,
          error: [BadRequestError, NotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.update",
            summary: "Update PTY session",
            description: "Update properties of an existing pseudo-terminal (PTY) session.",
          }),
        ),
        HttpApiEndpoint.delete("remove", `${root}/:ptyID`, {
          params: PtyParam,
          success: Schema.Boolean,
          error: NotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.remove",
            summary: "Remove PTY session",
            description: "Remove and terminate a specific pseudo-terminal (PTY) session.",
          }),
        ),
        HttpApiEndpoint.post("connectToken", `${root}/:ptyID/connect-token`, {
          params: PtyParam,
          success: ConnectToken,
          error: NotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pty.connectToken",
            summary: "Create PTY WebSocket token",
            description: "Create a short-lived ticket for opening a PTY WebSocket connection.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "pty",
          description: "HttpApi PTY JSON and connect-token routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode pty HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for PTY JSON and connect-token routes.",
    }),
  )
