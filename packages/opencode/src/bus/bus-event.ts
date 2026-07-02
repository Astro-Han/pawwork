import z from "zod"
import type { ZodType } from "zod"

export namespace BusEvent {
  export type Definition = ReturnType<typeof define>
  type PayloadOptions = {
    include?: Iterable<string>
  }

  const registry = new Map<string, Definition>()

  export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties) {
    const result = {
      type,
      properties,
    }
    registry.set(type, result)
    return result
  }

  function payloadEntries(options?: PayloadOptions) {
    if (!options?.include) return registry.entries().toArray()

    return Array.from(options.include, (type) => {
      const def = registry.get(type)
      if (!def) throw new Error(`Bus event schema is not registered: ${type}`)
      return [type, def] as const
    })
  }

  export function payloads(options?: PayloadOptions) {
    const schemas = payloadEntries(options).map(([type, def]) => {
      return z
        .object({
          type: z.literal(type),
          properties: def.properties,
        })
        .meta({
          ref: "Event" + "." + def.type,
        })
    })

    return z
      .discriminatedUnion("type", schemas as any)
      .meta({
        ref: "Event",
      })
  }
}
