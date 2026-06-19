import { resolver } from "hono-openapi"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { NotFoundError } from "../storage/db"

export const BadRequestErrorSchema = z
  .object({
    data: z.any(),
    errors: z.array(z.record(z.string(), z.any())),
    success: z.literal(false),
  })
  .meta({
    ref: "BadRequestError",
  })

export const ERRORS = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(BadRequestErrorSchema),
      },
    },
  },
  404: {
    description: "Not found",
    content: {
      "application/json": {
        schema: resolver(NotFoundError.Schema),
      },
    },
  },
  409: {
    description: "Conflict",
    content: {
      "application/json": {
        // ErrorMiddleware wraps Session.BusyError as NamedError.Unknown, so a
        // busy-session conflict serializes to the Unknown { name, data } shape.
        schema: resolver(NamedError.Unknown.Schema),
      },
    },
  },
} as const

export function errors(...codes: (keyof typeof ERRORS)[]) {
  return Object.fromEntries(
    codes.map((code) => {
      const entry = ERRORS[code]
      // Fail loudly instead of silently dropping the response: JSON.stringify
      // omits undefined, so an unregistered code used to vanish from the spec
      // (e.g. errors(409) became a no-op). Routes with bespoke error bodies
      // must declare them inline rather than route them through this helper.
      if (!entry) throw new Error(`errors(): no response schema registered for status ${code}`)
      return [code, entry]
    }),
  )
}
