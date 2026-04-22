import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import z from "zod"

export class Server extends Schema.Class<Server>("ServerConfig")({
  port: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))).annotate({
    description: "Port to listen on",
  }),
  hostname: Schema.optional(Schema.String).annotate({ description: "Hostname to listen on" }),
  mdns: Schema.optional(Schema.Boolean).annotate({ description: "Enable mDNS service discovery" }),
  mdnsDomain: Schema.optional(Schema.String).annotate({
    description: "Custom domain name for mDNS service (default: opencode.local)",
  }),
  cors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional domains to allow for CORS",
  }),
}) {
  static readonly zod = (() => {
    const schema = zod(this)
    if (!(schema instanceof z.ZodObject)) throw new Error("ServerConfig must bridge to a ZodObject")
    const meta = schema.meta()
    return meta ? schema.strict().meta(meta) : schema.strict()
  })()
}

export * as ConfigServer from "./server"
