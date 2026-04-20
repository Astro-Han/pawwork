import { test, expect } from "bun:test"
import { base64Encode as utilBase64Encode, checksum as utilChecksum } from "@opencode-ai/util/encode"
import { base64Encode as sharedBase64Encode, checksum as sharedChecksum } from "@opencode-ai/shared/util/encode"
import { getFilename as utilGetFilename } from "@opencode-ai/util/path"
import { getFilename as sharedGetFilename } from "@opencode-ai/shared/util/path"

test("util encode and path exports stay compatible with shared", () => {
  const sample = "PawWork 9b"
  const filepath = "/tmp/example/report.md"

  expect(utilBase64Encode(sample)).toBe(sharedBase64Encode(sample))
  expect(utilChecksum(sample)).toBe(sharedChecksum(sample))
  expect(utilGetFilename(filepath)).toBe(sharedGetFilename(filepath))
})
