const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { createRequire } = require('node:module')
const { extractDocument } = require(process.env.PAWWORK_READER_TEST_SCRIPT || './document-reader.cjs')
const hostModules = process.env.PAWWORK_READER_TEST_MODULES || resolve(__dirname, '../../../node_modules')
const req = createRequire(join(hostModules, '..', 'package.json'))

async function fixture(extension, data, run) {
  const directory = await mkdtemp(join(tmpdir(), 'pawwork-reader-test-'))
  try {
    const file = join(directory, `example.${extension}`)
    await writeFile(file, data)
    await run(file)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function pdfFile(scanned = false) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 220] /Resources << ${scanned ? '/XObject << /Im0 5 0 R >>' : '/Font << /F1 5 0 R >>'} >> /Contents 4 0 R >>`,
  ]
  const content = Buffer.from(scanned ? 'q 600 0 0 220 0 0 cm /Im0 Do Q' : 'BT /F1 16 Tf 30 150 Td (Project Alpha deadline is 14 November. Owner: Swapnil.) Tj ET')
  objects.push(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]))
  if (scanned) {
    const { createCanvas } = req('@napi-rs/canvas')
    const image = createCanvas(1200, 440)
    const ctx = image.getContext('2d')
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 440)
    ctx.fillStyle = 'black'; ctx.font = '42px Arial'
    ctx.fillText('PROJECT ALPHA', 50, 110)
    ctx.fillText('Deadline: 14 November', 50, 190)
    ctx.fillText('Owner: Swapnil', 50, 270)
    const jpeg = image.toBuffer('image/jpeg')
    objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 440 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]))
  } else objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.concat(chunks).length)
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(objects[i]), Buffer.from('\nendobj\n'))
  }
  const start = Buffer.concat(chunks).length
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`))
  return Buffer.concat(chunks)
}

test('extracts Word paragraphs and table cells without Word installed', async () => {
  const mammothRequire = createRequire(req.resolve('mammoth'))
  const zip = new (mammothRequire('jszip'))()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Project Alpha</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner: Swapnil</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
  await fixture('docx', await zip.generateAsync({ type: 'nodebuffer' }), async (file) => {
    const result = await extractDocument(file, hostModules)
    assert.match(result.text, /Project Alpha/)
    assert.match(result.text, /Owner: Swapnil/)
  })
})

test('extracts a text PDF with page references and does not use OCR', async () => {
  await fixture('pdf', pdfFile(), async (file) => {
    const result = await extractDocument(file, hostModules)
    assert.match(result.text, /\[Page 1\]/)
    assert.match(result.text, /14 November/)
    assert.deepEqual(result.ocrPages, [])
  })
})

test('recognizes a scanned PDF using bundled English OCR data', { timeout: 120_000 }, async () => {
  await fixture('pdf', pdfFile(true), async (file) => {
    const messages = []
    const result = await extractDocument(file, hostModules, (message) => messages.push(message))
    assert.match(result.text, /PROJECT ALPHA/i)
    assert.match(result.text, /14 November/i)
    assert.deepEqual(result.ocrPages, [1])
    assert.ok(messages.some((message) => message.includes('Recognizing scanned page')))
  })
})

test('rejects broken documents instead of giving the model binary content', async () => {
  await fixture('pdf', 'not a PDF', async (file) => {
    await assert.rejects(extractDocument(file, hostModules))
  })
})

module.exports = { pdfFile }
