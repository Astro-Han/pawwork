// Runs in a separate Node process: parsing and OCR never block the app window.
const { readFile, stat } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { extname, join } = require('node:path')
const { pathToFileURL } = require('node:url')

const MAX_BYTES = 25 * 1024 * 1024
const MAX_PAGES = 100
const MAX_TEXT = 120_000

async function extractDocument(file, hostModules, progress = () => {}) {
  const req = createRequire(join(hostModules, '..', 'package.json'))
  const info = await stat(file)
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Choose a document smaller than 25 MB.')
  const extension = extname(file).toLowerCase()
  const data = await readFile(file)
  if (extension === '.docx') {
    progress('Reading Word paragraphs and tables…')
    const result = await req('mammoth').extractRawText({ buffer: data })
    const text = result.value.trim()
    if (!text) throw new Error('This Word document has no readable text. It may contain only images.')
    if (text.length > MAX_TEXT) throw new Error('This document is too long for one attachment. Split it into smaller documents.')
    return { text, pages: null, ocrPages: [], warnings: result.messages.map((item) => item.message) }
  }
  if (extension !== '.pdf') throw new Error('Choose a PDF or a .docx Word document. Save older .doc files as .docx first.')
  const canvas = req('@napi-rs/canvas')
  globalThis.DOMMatrix ??= canvas.DOMMatrix
  globalThis.ImageData ??= canvas.ImageData
  globalThis.Path2D ??= canvas.Path2D
  const { getDocument } = await import(pathToFileURL(req.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)
  const pdfRoot = join(req.resolve('pdfjs-dist/package.json'), '..')
  const loading = getDocument({
    data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: true,
    standardFontDataUrl: pathToFileURL(join(pdfRoot, 'standard_fonts') + '/').href,
    cMapUrl: pathToFileURL(join(pdfRoot, 'cmaps') + '/').href, cMapPacked: true,
  })
  let pdf, worker
  try {
    pdf = await loading.promise
    if (pdf.numPages > MAX_PAGES) throw new Error('Choose a PDF with 100 pages or fewer, or split it into smaller files.')
    const sections = [], ocrPages = [], warnings = []
    let length = 0
    for (let number = 1; number <= pdf.numPages; number++) {
      progress(`Reading page ${number} of ${pdf.numPages}…`)
      const page = await pdf.getPage(number)
      try {
        const content = await page.getTextContent()
        let text = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()
        if (text.replace(/\s/g, '').length < 30) {
          progress(`Recognizing scanned page ${number} of ${pdf.numPages}…`)
          if (!worker) {
            const { createWorker } = req('tesseract.js')
            const language = req('@tesseract.js-data/eng')
            worker = await createWorker('eng', 1, {
              langPath: language.langPath, gzip: true, cacheMethod: 'none',
              // All assets are bundled. No language downloads or remote OCR services.
            })
          }
          const original = page.getViewport({ scale: 2 })
          const scale = Math.min(2, Math.sqrt(12_000_000 / (original.width * original.height)) * 2)
          const viewport = page.getViewport({ scale })
          const image = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
          await page.render({ canvas: image, canvasContext: image.getContext('2d'), viewport }).promise
          const result = await worker.recognize(image.toBuffer('image/png'))
          text = result.data.text.trim() || text
          ocrPages.push(number)
          if (result.data.confidence < 70) warnings.push(`Page ${number}: OCR confidence is low; check names, figures, and tables against the original.`)
        }
        if (!text) warnings.push(`Page ${number}: no readable text was found.`)
        length += text.length
        if (length > MAX_TEXT) throw new Error('This PDF contains too much text for one attachment. Split it into smaller files.')
        sections.push(`[Page ${number}]\n${text || '[No readable text]'}`)
      } finally { page.cleanup() }
    }
    if (sections.every((section) => section.endsWith('[No readable text]'))) throw new Error('No readable text was found in this PDF. Try a clearer scan.')
    return { text: sections.join('\n\n'), pages: pdf.numPages, ocrPages, warnings }
  } finally {
    if (worker) await worker.terminate()
    await loading.destroy()
  }
}

module.exports = { extractDocument }
if (require.main === module) {
  extractDocument(process.argv[2], process.argv[3], (message) => {
    process.stderr.write(`PAWWORK_PROGRESS:${JSON.stringify(message)}\n`)
  }).then((result) => process.stdout.write(`PAWWORK_RESULT:${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`PAWWORK_ERROR:${error.message}\n`); process.exitCode = 1 })
}
