import { describe, expect, test } from "bun:test"
import { modelSupportsInput, routeBrowserFile, routePickedPath } from "./attachment-routing"

const mockModel = (input: Partial<Record<"text" | "image" | "audio" | "video" | "pdf", boolean>>) => ({
  capabilities: {
    input: {
      text: input.text ?? true,
      image: input.image ?? false,
      audio: input.audio ?? false,
      video: input.video ?? false,
      pdf: input.pdf ?? false,
    },
  },
})

describe("modelSupportsInput", () => {
  test("uses capabilities input flags", () => {
    expect(modelSupportsInput(mockModel({ image: true }), "image")).toBe(true)
    expect(modelSupportsInput(mockModel({ pdf: false }), "pdf")).toBe(false)
  })

  test("treats image-capable models as PDF-capable fallback", () => {
    expect(modelSupportsInput(mockModel({ image: true, pdf: false }), "pdf")).toBe(true)
  })

  test("uses modalities as a narrow fallback", () => {
    expect(modelSupportsInput({ modalities: { input: ["text", "pdf"] } }, "pdf")).toBe(true)
    expect(modelSupportsInput({ modalities: { input: ["text"] } }, "image")).toBe(false)
    expect(modelSupportsInput({ modalities: { input: ["text", "image"] } }, "pdf")).toBe(true)
  })
})

describe("routeBrowserFile", () => {
  test("routes supported images to direct image attachment", async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], "photo.png", { type: "image/png" })
    expect(await routeBrowserFile(file, mockModel({ image: true }))).toEqual({
      type: "direct",
      media: "image",
      mime: "image/png",
    })
  })

  test("rejects images when the model cannot read images", async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], "photo.png", { type: "image/png" })
    expect(await routeBrowserFile(file, mockModel({ image: false }))).toEqual({
      type: "reject-image",
      mime: "image/png",
    })
  })

  test("routes supported PDFs to direct PDF attachment", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await routeBrowserFile(file, mockModel({ pdf: true }))).toEqual({
      type: "direct",
      media: "pdf",
      mime: "application/pdf",
    })
  })

  test("routes unsupported PDFs to path fallback", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await routeBrowserFile(file, mockModel({ pdf: false }))).toEqual({
      type: "path",
      reason: "unsupported-pdf",
    })
  })

  test("routes PDFs to direct attachment for image-capable models", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await routeBrowserFile(file, mockModel({ image: true, pdf: false }))).toEqual({
      type: "direct",
      media: "pdf",
      mime: "application/pdf",
    })
  })

  test("routes browser files with text suffixes to text path fallback", async () => {
    const file = new File(["<html></html>"], "index.html", { type: "text/html" })
    expect(await routeBrowserFile(file, mockModel({ image: false }))).toEqual({ type: "path", reason: "text" })
  })

  test("routes browser files with detected text MIME to text path fallback", async () => {
    const file = new File(["<html></html>"], "archive.bin", { type: "text/html" })
    expect(await routeBrowserFile(file, mockModel({ image: false }))).toEqual({ type: "path", reason: "text" })
  })
})

describe("routePickedPath", () => {
  test("routes Office files to path fallback", () => {
    expect(routePickedPath("/Users/me/report.docx", mockModel({}))).toEqual({ type: "path", reason: "office" })
    expect(routePickedPath("/Users/me/sheet.xlsx", mockModel({}))).toEqual({ type: "path", reason: "office" })
    expect(routePickedPath("/Users/me/deck.pptx", mockModel({}))).toEqual({ type: "path", reason: "office" })
    expect(routePickedPath("C:\\Users\\me\\report.docx", mockModel({}))).toEqual({ type: "path", reason: "office" })
  })

  test("routes unknown picked files to path fallback", () => {
    expect(routePickedPath("/Users/me/archive.bin", mockModel({}))).toEqual({ type: "path", reason: "unknown" })
  })

  test("routes common code and config files to text path fallback", () => {
    for (const suffix of [
      "dart",
      "gql",
      "graphql",
      "ini",
      "java",
      "jsx",
      "kt",
      "kts",
      "properties",
      "proto",
      "rb",
      "scss",
      "sh",
      "sol",
      "sql",
      "svelte",
      "swift",
      "toml",
      "vue",
    ]) {
      expect(routePickedPath(`/Users/me/file.${suffix}`, mockModel({}))).toEqual({ type: "path", reason: "text" })
    }
  })

  test("keeps question marks and hashes inside filenames when extracting suffixes", () => {
    expect(routePickedPath("/Users/me/config?v2.json", mockModel({}))).toEqual({ type: "path", reason: "text" })
    expect(routePickedPath("/Users/me/page#draft.html", mockModel({}))).toEqual({ type: "path", reason: "text" })
  })

  test("does not treat dotfile names as suffixes", () => {
    expect(routePickedPath("/Users/me/.gitignore", mockModel({}))).toEqual({ type: "path", reason: "unknown" })
    expect(routePickedPath("/Users/me/.png", mockModel({ image: true }))).toEqual({ type: "path", reason: "unknown" })
  })

  test("routes picked media by model support", () => {
    expect(routePickedPath("/Users/me/photo.jpg", mockModel({ image: true }))).toEqual({
      type: "direct",
      media: "image",
      mime: "image/jpeg",
    })
    expect(routePickedPath("/Users/me/photo.jpg", mockModel({ image: false }))).toEqual({
      type: "reject-image",
      mime: "image/jpeg",
    })
    expect(routePickedPath("/Users/me/guide.pdf", mockModel({ pdf: false }))).toEqual({
      type: "path",
      reason: "unsupported-pdf",
    })
    expect(routePickedPath("/Users/me/guide.pdf", mockModel({ image: true, pdf: false }))).toEqual({
      type: "direct",
      media: "pdf",
      mime: "application/pdf",
    })
  })
})
