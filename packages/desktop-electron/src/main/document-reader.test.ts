import { expect, test } from "vitest"
import { readDocument, readUploadedDocument } from "./document-reader"
import { resolve } from "node:path"

const options = {
  executable: process.execPath,
  script: resolve(import.meta.dirname, "../../resources/dsh/product/document-reader.cjs"),
  hostModules: resolve(import.meta.dirname, "../../node_modules"),
}

test("validates uploaded document types and sizes before parsing", async () => {
  await expect(readUploadedDocument("script.exe", new Uint8Array(), options)).rejects.toThrow("Choose a PDF")
  await expect(readUploadedDocument("huge.pdf", new Uint8Array(26 * 1024 * 1024), options)).rejects.toThrow("25 MB")
  await expect(readDocument("old.doc", options)).rejects.toThrow("Choose a PDF")
})

test("surfaces parser failure from the subprocess instead of returning binary bytes", async () => {
  await expect(readUploadedDocument("broken.pdf", new Uint8Array([1, 2, 3]), options)).rejects.toThrow("Invalid PDF")
})
