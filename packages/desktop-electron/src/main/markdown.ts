import { marked, type Tokens } from "marked"

const renderer = new marked.Renderer()

renderer.link = ({ href, title, text }: Tokens.Link) => {
  const titleAttr = title ? ` title="${title}"` : ""
  // The desktop renderer's document-level handler grabs every .external-link
  // and routes it to shell.openExternal. Only mark true remote links so hash
  // anchors and repo paths fall through to the markdown component's own
  // click handler (scroll / Finder reveal). Keep this in sync with the
  // jsParser branch in packages/ui/src/context/marked.tsx.
  const remote = /^(?:https?:\/\/|mailto:)/i.test(href)
  if (remote) {
    return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
  }
  return `<a href="${href}"${titleAttr}>${text}</a>`
}

export function parseMarkdown(input: string) {
  return marked(input, {
    renderer,
    breaks: false,
    gfm: true,
  })
}
