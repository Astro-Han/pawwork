import { render } from "solid-js/web"
import { PromptAttachmentChips } from "@/components/prompt-input/attachment-chips"
import type { FloatingAttachment } from "@/context/prompt"

// Inline SVG thumbnail stands in for a real screenshot so the snap needs no
// binary fixture file and stays deterministic across machines.
const THUMB_SVG =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112">` +
      `<rect width="112" height="112" fill="#d97757"/>` +
      `<circle cx="36" cy="40" r="16" fill="#faf9f5"/>` +
      `<rect x="20" y="68" width="72" height="24" rx="4" fill="#faf9f5"/>` +
      `</svg>`,
  )

const pathImage: FloatingAttachment = {
  type: "attachment",
  id: "att_path_image",
  path: "/Users/me/Desktop/screenshot 2026-06-10.png",
  filename: "screenshot 2026-06-10.png",
  mime: "image/png",
  size: 482_133,
}

const pathPdf: FloatingAttachment = {
  type: "attachment",
  id: "att_path_pdf",
  path: "/Users/me/Documents/quarterly-report.pdf",
  filename: "quarterly-report.pdf",
  mime: "application/pdf",
  size: 1_204_224,
}

const pathLongName: FloatingAttachment = {
  type: "attachment",
  id: "att_path_long",
  path: "/Users/me/Downloads/a-very-long-vendor-contract-amendment-final-v3-signed.docx",
  filename: "a-very-long-vendor-contract-amendment-final-v3-signed.docx",
  size: 88_064,
}

const legacyImage: FloatingAttachment = {
  type: "image",
  id: "att_legacy_image",
  filename: "pasted-image.png",
  mime: "image/png",
  dataUrl: THUMB_SVG,
}

const legacyText: FloatingAttachment = {
  type: "image",
  id: "att_legacy_text",
  filename: "notes.txt",
  mime: "text/plain",
  dataUrl: "data:text/plain;base64,aGVsbG8=",
}

const brokenPreviewImage: FloatingAttachment = {
  type: "attachment",
  id: "att_broken_preview",
  path: "/Users/me/Desktop/missing.png",
  filename: "missing.png",
  mime: "image/png",
  size: 12_288,
}

const noop = () => {}

async function loadPreview(path: string): Promise<string | null> {
  if (path.endsWith("missing.png")) return null
  return THUMB_SVG
}

function Block(props: { snap: string; attachments: FloatingAttachment[] }) {
  return (
    <div data-snap={props.snap} style={{ width: "560px", background: "var(--bg-base)", "padding-bottom": "12px" }}>
      <PromptAttachmentChips
        attachments={props.attachments}
        // Recorded on <body> so the spec can assert keyboard activation.
        onOpenImage={(image) => {
          document.body.dataset.openedImage = image.alt
        }}
        onReveal={noop}
        onRemove={noop}
        loadPreview={loadPreview}
        removeLabel="Remove attachment"
        revealLabel="Show in folder"
      />
    </div>
  )
}

function AttachmentChipsFixture() {
  return (
    <div style={{ display: "grid", gap: "20px", padding: "24px", background: "var(--bg-base)" }}>
      {/* Path-backed chips: image thumbnail via loadPreview, pdf card with size, long-name truncation. */}
      <Block snap="path-backed" attachments={[pathImage, pathPdf, pathLongName]} />
      {/* Legacy data-URL parts render through the same chip component. */}
      <Block snap="legacy" attachments={[legacyImage, legacyText]} />
      {/* Image whose preview fails falls back to the file-card body. */}
      <Block snap="preview-fallback" attachments={[brokenPreviewImage]} />
    </div>
  )
}

export function mountAttachmentChipsFixture(root: HTMLElement) {
  render(() => <AttachmentChipsFixture />, root)
}
