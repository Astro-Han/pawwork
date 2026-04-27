import { test, expect } from "bun:test"
import { base64Encode as utilBase64Encode, checksum as utilChecksum } from "@opencode-ai/util/encode"
import { base64Encode as coreBase64Encode, checksum as coreChecksum } from "@opencode-ai/core/util/encode"
import { getFilename as utilGetFilename } from "@opencode-ai/util/path"
import { getFilename as coreGetFilename } from "@opencode-ai/core/util/path"

test("util encode and path exports stay compatible with core", () => {
  const sample = "PawWork 9b"
  const filepath = "/tmp/example/report.md"

  expect(utilBase64Encode(sample)).toBe(coreBase64Encode(sample))
  expect(utilChecksum(sample)).toBe(coreChecksum(sample))
  expect(utilGetFilename(filepath)).toBe(coreGetFilename(filepath))
})
