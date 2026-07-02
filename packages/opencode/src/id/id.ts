import z from "zod"
import { randomBytes } from "crypto"
import { randomBase62 } from "@opencode-ai/core/util/base62"

export namespace Identifier {
  const prefixes = {
    event: "evt",
    session: "ses",
    message: "msg",
    permission: "per",
    question: "que",
    automation: "automation",
    automation_run: "automation_run",
    todo: "todo",
    user: "usr",
    part: "prt",
    pty: "pty",
    tool: "tool",
    workspace: "wrk",
  } as const

  type Prefix = keyof typeof prefixes

  function prefixOf(id: string): Prefix | undefined {
    let result: Prefix | undefined
    for (const [key, value] of Object.entries(prefixes) as [Prefix, string][]) {
      if (!id.startsWith(value + "_")) continue
      if (!result || value.length > prefixes[result].length) result = key
    }
    return result
  }

  export function schema(prefix: Prefix) {
    return z.string().refine((id) => prefixOf(id) === prefix, {
      message: `ID must use ${prefixes[prefix]} prefix`,
    })
  }

  const LENGTH = 26

  let lastTimestamp = 0
  let counter = 0

  export function ascending(prefix: Prefix, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: Prefix, given?: string) {
    return generateID(prefix, true, given)
  }

  function generateID(prefix: Prefix, descending: boolean, given?: string): string {
    if (!given) {
      return create(prefix, descending)
    }

    if (prefixOf(given) !== prefix) {
      throw new Error(`ID ${given} does not use ${prefixes[prefix]} prefix`)
    }
    return given
  }

  export function create(prefix: Prefix, descending: boolean, timestamp?: number): string {
    const currentTimestamp = timestamp ?? Date.now()

    if (currentTimestamp !== lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++

    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

    now = descending ? ~now : now

    const timeBytes = Buffer.alloc(6)
    for (let i = 0; i < 6; i++) {
      timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
    }

    return prefixes[prefix] + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12, randomBytes)
  }

  /** Extract timestamp from an ascending ID. Does not work with descending IDs. */
  export function timestamp(id: string): number {
    const separator = id.lastIndexOf("_")
    if (separator === -1) {
      throw new Error("ID timestamp must be a 12-character hex string")
    }
    const hex = id.slice(separator + 1, separator + 13)
    if (!/^[0-9a-f]{12}$/i.test(hex)) {
      throw new Error("ID timestamp must be a 12-character hex string")
    }
    const encoded = BigInt("0x" + hex)
    return Number(encoded / BigInt(0x1000))
  }
}
