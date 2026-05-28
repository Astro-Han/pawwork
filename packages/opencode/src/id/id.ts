import z from "zod"
import { randomBytes } from "crypto"

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

  const LENGTH = 26
  const TIME_HEX_LENGTH = 12

  function pattern(prefix: keyof typeof prefixes) {
    return new RegExp(`^${prefixes[prefix]}_[0-9a-f]{${TIME_HEX_LENGTH}}[0-9A-Za-z]{${LENGTH - TIME_HEX_LENGTH}}$`)
  }

  export function schema(prefix: keyof typeof prefixes) {
    return z.string().regex(pattern(prefix))
  }

  // State for monotonic ID generation
  let lastTimestamp = 0
  let counter = 0

  export function ascending(prefix: keyof typeof prefixes, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: keyof typeof prefixes, given?: string) {
    return generateID(prefix, true, given)
  }

  function generateID(prefix: keyof typeof prefixes, descending: boolean, given?: string): string {
    if (!given) {
      return create(prefix, descending)
    }

    if (!pattern(prefix).test(given)) {
      throw new Error(`ID ${given} does not match ${prefixes[prefix]} ID format`)
    }
    return given
  }

  function randomBase62(length: number): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    let result = ""
    const bytes = randomBytes(length)
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  export function create(prefix: keyof typeof prefixes, descending: boolean, timestamp?: number): string {
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

    return prefixes[prefix] + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
  }

  /** Extract timestamp from an ascending ID. Does not work with descending IDs. */
  export function timestamp(id: string): number {
    const separator = id.lastIndexOf("_")
    const hex = id.slice(separator + 1, separator + 13)
    const encoded = BigInt("0x" + hex)
    return Number(encoded / BigInt(0x1000))
  }
}
