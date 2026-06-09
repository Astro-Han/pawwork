import { test, expect } from "bun:test"
import { findLast as utilFindLast } from "@opencode-ai/util/array"
import { findLast as coreFindLast } from "@opencode-ai/core/util/array"
import { Binary as utilBinary } from "@opencode-ai/util/binary"
import { Binary as coreBinary } from "@opencode-ai/core/util/binary"
import { NamedError as UtilNamedError } from "@opencode-ai/util/error"
import { NamedError as CoreNamedError } from "@opencode-ai/core/util/error"
import { fn as utilFn } from "@opencode-ai/util/fn"
import { fn as coreFn } from "@opencode-ai/core/util/fn"
import { Identifier as coreIdentifier } from "@opencode-ai/core/util/identifier"
import { Identifier as utilIdentifier } from "@opencode-ai/util/identifier"
import { randomBase62 as utilRandomBase62 } from "@opencode-ai/util/base62"
import { randomBase62 as coreRandomBase62 } from "@opencode-ai/core/util/base62"
import { iife as utilIife } from "@opencode-ai/util/iife"
import { iife as coreIife } from "@opencode-ai/core/util/iife"
import { lazy as utilLazy } from "@opencode-ai/util/lazy"
import { lazy as coreLazy } from "@opencode-ai/core/util/lazy"
import { Module as utilModule } from "@opencode-ai/util/module"
import { Module as coreModule } from "@opencode-ai/core/util/module"
import { retry as utilRetry } from "@opencode-ai/util/retry"
import { retry as coreRetry } from "@opencode-ai/core/util/retry"
import { Slug as utilSlug } from "@opencode-ai/util/slug"
import { Slug as coreSlug } from "@opencode-ai/core/util/slug"
import { z } from "zod"

test("core util surface stays aligned with compatibility util surface", async () => {
  expect(coreFindLast([1, 2, 3, 4], (item) => item % 2 === 0)).toBe(utilFindLast([1, 2, 3, 4], (item) => item % 2 === 0))
  expect(coreBinary.search([{ id: "a" }, { id: "c" }], "b", (item) => item.id)).toEqual(
    utilBinary.search([{ id: "a" }, { id: "c" }], "b", (item) => item.id),
  )

  const UtilExampleError = UtilNamedError.create("UtilExampleError", z.object({ ok: z.boolean() }))
  const CoreExampleError = CoreNamedError.create("CoreExampleError", z.object({ ok: z.boolean() }))
  expect(new UtilExampleError({ ok: true }).toObject()).toEqual({ name: "UtilExampleError", data: { ok: true } })
  expect(new CoreExampleError({ ok: true }).toObject()).toEqual({ name: "CoreExampleError", data: { ok: true } })

  expect(utilFn(z.string(), (value) => value.toUpperCase())("pawwork")).toBe(coreFn(z.string(), (value) => value.toUpperCase())("pawwork"))
  expect(utilIife(() => "ready")).toBe(coreIife(() => "ready"))

  let utilCalls = 0
  let coreCalls = 0
  const utilLoad = utilLazy(() => {
    utilCalls += 1
    return "util"
  })
  const coreLoad = coreLazy(() => {
    coreCalls += 1
    return "core"
  })
  expect(utilLoad()).toBe("util")
  expect(utilLoad()).toBe("util")
  expect(coreLoad()).toBe("core")
  expect(coreLoad()).toBe("core")
  expect(utilCalls).toBe(1)
  expect(coreCalls).toBe(1)

  expect(typeof utilIdentifier.ascending()).toBe("string")
  expect(typeof coreIdentifier.ascending()).toBe("string")
  expect(utilRandomBase62(4, (size) => [248, ...Array.from({ length: size }, () => 61)])).toBe(
    coreRandomBase62(4, (size) => [248, ...Array.from({ length: size }, () => 61)]),
  )
  expect(utilModule.resolve("node:path", process.cwd())).toBe(coreModule.resolve("node:path", process.cwd()))

  expect(await utilRetry(async () => "ok", { attempts: 1 })).toBe(await coreRetry(async () => "ok", { attempts: 1 }))
  expect(typeof utilSlug.create()).toBe("string")
  expect(typeof coreSlug.create()).toBe("string")
})
