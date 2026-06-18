import fs from "fs/promises"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { LSP } from "@/lsp"
import { Skill } from "@/skill"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Vcs } from "@/project/vcs"
import { PawWorkHome } from "@opencode-ai/core/pawwork-home"
import { Runtime } from "@opencode-ai/core/runtime"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootApi } from "../groups/root"

const applyPatchTooLarge = () =>
  ({
    error: "vcs_apply_failed",
    reason: "too-large",
    message: "Patch exceeds the 10 MB input limit",
  }) satisfies Vcs.ApplyError

const applyPatchInvalidInput = () =>
  ({
    error: "vcs_apply_failed",
    reason: "invalid-input",
    message: "Patch request body must be valid JSON with a string patch",
  }) satisfies Vcs.ApplyError

const applyJsonEnvelopeBytes = Buffer.byteLength(JSON.stringify({ patch: "" }))
const maxJsonStringEscapeRatio = 6
const applyJsonBodyMaxBytes = Vcs.MAX_APPLY_PATCH_BYTES * maxJsonStringEscapeRatio + applyJsonEnvelopeBytes

function isJsonRequest(request: HttpServerRequest.HttpServerRequest) {
  return request.headers["content-type"]?.includes("json") === true
}

function contentLengthTooLarge(request: HttpServerRequest.HttpServerRequest) {
  const contentLength = request.headers["content-length"]
  return contentLength !== undefined && Number.parseInt(contentLength, 10) > applyJsonBodyMaxBytes
}

function applyErrorResponse(body: Vcs.ApplyError, status: 400 | 413) {
  return HttpServerResponse.jsonUnsafe(body, { status })
}

const parseApplyBody = Effect.fn("RootHttpApi.vcsApplyBody")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  if (contentLengthTooLarge(request)) return applyErrorResponse(applyPatchTooLarge(), 413)

  if (!isJsonRequest(request)) return applyErrorResponse(applyPatchInvalidInput(), 400)

  const text = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")))
  if (Buffer.byteLength(text) > applyJsonBodyMaxBytes) return applyErrorResponse(applyPatchTooLarge(), 413)

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return applyErrorResponse(applyPatchInvalidInput(), 400)
  }

  const parsed = Vcs.ApplyInput.safeParse(body)
  if (!parsed.success) return applyErrorResponse(applyPatchInvalidInput(), 400)
  return parsed.data
})

const getPaths = Effect.fn("RootHttpApi.path")(function* (ensureConfig: boolean) {
  const config = Runtime.isPawWork()
    ? ensureConfig
      ? yield* Effect.promise(() => PawWorkHome.ensurePrimary())
      : PawWorkHome.primary()
    : Global.Path.config
  if (ensureConfig && !Runtime.isPawWork()) {
    yield* Effect.promise(() => fs.mkdir(config, { recursive: true }))
  }
  return {
    home: Global.Path.home,
    state: Global.Path.state,
    config,
    worktree: Instance.worktree,
    directory: Instance.directory,
  }
})

function vcsApplyFailure(error: unknown) {
  if (error instanceof Vcs.PatchApplyError) {
    const body =
      error.reason === "too-large"
        ? applyPatchTooLarge()
        : ({
            error: "vcs_apply_failed",
            reason: error.reason,
            message: error.message,
          } satisfies Vcs.ApplyError)
    return Effect.succeed(applyErrorResponse(body, error.reason === "too-large" ? 413 : 400))
  }
  return Effect.die(error)
}

export const rootHandlers = HttpApiBuilder.group(RootApi, "root", (handlers) =>
  handlers
    .handleRaw("instanceDispose", () =>
      Effect.promise(() => Instance.dispose()).pipe(Effect.as(HttpServerResponse.jsonUnsafe(true))),
    )
    .handleRaw("path", (ctx) =>
      getPaths(ctx.query.ensureConfig === "true").pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    )
    .handleRaw("vcs", () =>
      Effect.gen(function* () {
        const vcs = yield* Vcs.Service
        const [branch, defaultBranch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
        return HttpServerResponse.jsonUnsafe({ branch, default_branch: defaultBranch })
      }),
    )
    .handleRaw("vcsStatus", () =>
      Vcs.Service.use((vcs) => vcs.status()).pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    )
    .handleRaw("vcsDiff", (ctx) =>
      Vcs.Service.use((vcs) => vcs.diff(ctx.query.mode)).pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    )
    .handleRaw("vcsDiffRaw", () =>
      Vcs.Service.use((vcs) => vcs.diffRaw()).pipe(
        Effect.map((result) =>
          HttpServerResponse.raw(result, {
            contentType: "text/plain; charset=UTF-8",
          }),
        ),
        Effect.catch((error) => {
          if (error instanceof Vcs.RawDiffError) {
            return Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                {
                  error: "vcs_diff_raw_failed",
                  reason: error.reason,
                  message: error.message,
                } satisfies Vcs.DiffRawError,
                { status: 413 },
              ),
            )
          }
          return Effect.fail(error)
        }),
      ),
    )
    .handleRaw("vcsApply", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseApplyBody(ctx.request)
        if (HttpServerResponse.isHttpServerResponse(body)) return body

        const result = yield* Vcs.Service.use((vcs) => vcs.apply(body)).pipe(
          Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
          Effect.catch(vcsApplyFailure),
        )
        return result
      }),
    )
    .handleRaw("command", () =>
      Command.Service.use((command) => command.list()).pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    )
    .handleRaw("agent", () =>
      Agent.Service.use((agent) => agent.list()).pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    )
    .handleRaw("skill", () =>
      Skill.Service.use((skill) => skill.all()).pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    )
    .handleRaw("lsp", () =>
      LSP.Service.use((lsp) => lsp.status()).pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    ),
)
