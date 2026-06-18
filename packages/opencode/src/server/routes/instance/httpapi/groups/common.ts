import { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"

export const WorkspaceRoutingQuery = Schema.Struct({
  directory: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
})

export const BadRequestError = Schema.Struct({
  data: Schema.Any,
  error: Schema.Array(Schema.Record(Schema.String, Schema.Any)),
  success: Schema.Literal(false),
}).pipe(
  HttpApiSchema.status(400),
  (schema) =>
    schema.annotate({
      identifier: "BadRequestError",
      description: "Bad request",
    }),
)

export const InvalidMemoryFileError = Schema.Struct({
  error: Schema.Literal("invalid_memory_file"),
  reason: Schema.String,
}).pipe(
  HttpApiSchema.status(400),
  (schema) =>
    schema.annotate({
      identifier: "InvalidMemoryFileError",
      description: "Invalid PawWork memory file",
    }),
)

export const NotFoundError = Schema.Struct({
  name: Schema.Literal("NotFoundError"),
  data: Schema.Struct({
    message: Schema.String,
  }),
}).pipe(
  HttpApiSchema.status(404),
  (schema) =>
    schema.annotate({
      identifier: "NotFoundError",
      description: "Not found",
    }),
)
