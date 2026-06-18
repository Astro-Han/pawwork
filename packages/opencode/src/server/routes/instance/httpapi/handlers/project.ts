import { Instance } from "@/project/instance"
import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import { initGit, listProjects, updateProject } from "@/server/instance/project"
import { NotFoundError } from "@/storage/db"
import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { ProjectApi } from "../groups/project"

function isJsonContentType(contentType: string | undefined) {
  return /^application\/([a-z-.]+\+)?json(?:;\s*[a-zA-Z0-9-]+=([^;]+))*$/.test(contentType ?? "")
}

function badRequestJson(body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, { status: 400 })
}

function parseJsonBody<T>(request: HttpServerRequest.HttpServerRequest, schema: z.ZodType<T>) {
  return Effect.gen(function* () {
    const body = isJsonContentType(request.headers["content-type"])
      ? yield* request.json.pipe(
          Effect.catch(() => Effect.succeed(HttpServerResponse.raw("Malformed JSON in request body", { status: 400 }))),
        )
      : {}
    if (HttpServerResponse.isHttpServerResponse(body)) return body

    const parsed = schema.safeParse(body)
    if (!parsed.success) return badRequestJson({ data: body, error: parsed.error.issues, success: false })
    return parsed.data
  })
}

function projectFailure(error: unknown) {
  if (error instanceof NotFoundError || error instanceof NamedError) {
    const status = error instanceof NotFoundError ? 404 : 500
    return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status }))
  }
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      new NamedError.Unknown({ message: "Unexpected server error. Check server logs for details." }).toObject(),
      { status: 500 },
    ),
  )
}

export const projectHandlers = HttpApiBuilder.group(ProjectApi, "project", (handlers) =>
  handlers
    .handleRaw("list", () => listProjects().pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))))
    .handleRaw("current", () => Effect.succeed(HttpServerResponse.jsonUnsafe(Instance.project)))
    .handleRaw("initGit", () =>
      initGit({ directory: Instance.directory, project: Instance.project }).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
      ),
    )
    .handleRaw("update", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, Project.UpdateInput.omit({ projectID: true }))
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        const project = yield* updateProject({ ...payload, projectID: ProjectID.make(ctx.params.projectID) }).pipe(
          Effect.catch(projectFailure),
          Effect.catchDefect(projectFailure),
        )
        if (HttpServerResponse.isHttpServerResponse(project)) return project
        return HttpServerResponse.jsonUnsafe(project)
      }),
    ),
)
