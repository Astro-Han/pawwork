import { Schema } from "effect"
import z from "zod"
import { zod, ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

// Keep config model IDs as provider/model strings in generated SDK types.
// External model schema references make the OpenAPI client generator resolve
// these fields to the full Model object, which is not the config file shape.
export const ConfigModelID = Schema.String.annotate({
  [ZodOverride]: z.string().regex(/^[^/]+\/[^/].*$/, "Expected provider/model"),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type ConfigModelID = Schema.Schema.Type<typeof ConfigModelID>
