import { test, expect } from "bun:test"
import { findLast as utilFindLast } from "@opencode-ai/util/array"
import { findLast as sharedFindLast } from "@opencode-ai/shared/util/array"
import { Binary as utilBinary } from "@opencode-ai/util/binary"
import { Binary as sharedBinary } from "@opencode-ai/shared/util/binary"
import { NamedError as UtilNamedError } from "@opencode-ai/util/error"
import { NamedError as SharedNamedError } from "@opencode-ai/shared/util/error"
import { fn as utilFn } from "@opencode-ai/util/fn"
import { fn as sharedFn } from "@opencode-ai/shared/util/fn"
import { Identifier as sharedIdentifier } from "@opencode-ai/shared/util/identifier"
import { Identifier as utilIdentifier } from "@opencode-ai/util/identifier"
import { iife as utilIife } from "@opencode-ai/util/iife"
import { iife as sharedIife } from "@opencode-ai/shared/util/iife"
import { lazy as utilLazy } from "@opencode-ai/util/lazy"
import { lazy as sharedLazy } from "@opencode-ai/shared/util/lazy"
import { Module as utilModule } from "@opencode-ai/util/module"
import { Module as sharedModule } from "@opencode-ai/shared/util/module"
import { retry as utilRetry } from "@opencode-ai/util/retry"
import { retry as sharedRetry } from "@opencode-ai/shared/util/retry"
import { Slug as utilSlug } from "@opencode-ai/util/slug"
import { Slug as sharedSlug } from "@opencode-ai/shared/util/slug"
import { z } from "zod"

test("shared util surface stays aligned with compatibility util surface", async () => {
  expect(sharedFindLast([1, 2, 3, 4], (item) => item % 2 === 0)).toBe(utilFindLast([1, 2, 3, 4], (item) => item % 2 === 0))
  expect(sharedBinary.search([{ id: "a" }, { id: "c" }], "b", (item) => item.id)).toEqual(
    utilBinary.search([{ id: "a" }, { id: "c" }], "b", (item) => item.id),
  )

  const UtilExampleError = UtilNamedError.create("UtilExampleError", z.object({ ok: z.boolean() }))
  const SharedExampleError = SharedNamedError.create("SharedExampleError", z.object({ ok: z.boolean() }))
  expect(new UtilExampleError({ ok: true }).toObject()).toEqual({ name: "UtilExampleError", data: { ok: true } })
  expect(new SharedExampleError({ ok: true }).toObject()).toEqual({ name: "SharedExampleError", data: { ok: true } })

  expect(utilFn(z.string(), (value) => value.toUpperCase())("pawwork")).toBe(sharedFn(z.string(), (value) => value.toUpperCase())("pawwork"))
  expect(utilIife(() => "ready")).toBe(sharedIife(() => "ready"))

  let utilCalls = 0
  let sharedCalls = 0
  const utilLoad = utilLazy(() => {
    utilCalls += 1
    return "util"
  })
  const sharedLoad = sharedLazy(() => {
    sharedCalls += 1
    return "shared"
  })
  expect(utilLoad()).toBe("util")
  expect(utilLoad()).toBe("util")
  expect(sharedLoad()).toBe("shared")
  expect(sharedLoad()).toBe("shared")
  expect(utilCalls).toBe(1)
  expect(sharedCalls).toBe(1)

  expect(typeof utilIdentifier.ascending()).toBe("string")
  expect(typeof sharedIdentifier.ascending()).toBe("string")
  expect(utilModule.resolve("node:path", process.cwd())).toBe(sharedModule.resolve("node:path", process.cwd()))

  expect(await utilRetry(async () => "ok", { attempts: 1 })).toBe(await sharedRetry(async () => "ok", { attempts: 1 }))
  expect(typeof utilSlug.create()).toBe("string")
  expect(typeof sharedSlug.create()).toBe("string")
})
