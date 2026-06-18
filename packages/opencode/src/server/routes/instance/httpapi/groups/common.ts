import { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"

export const WorkspaceRoutingQuery = Schema.Struct({
  directory: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
})

export const BadRequestError = Schema.Struct({
  data: Schema.Any,
  errors: Schema.Array(Schema.Record(Schema.String, Schema.Any)),
  success: Schema.Literal(false),
}).pipe(
  HttpApiSchema.status(400),
  (schema) =>
    schema.annotate({
      identifier: "BadRequestError",
      description: "Bad request",
    }),
)
