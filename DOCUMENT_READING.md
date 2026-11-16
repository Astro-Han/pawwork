# Reading documents in PawWork

After restarting the updated app, use PawWork's paperclip button to choose a PDF
or `.docx` file. Drag-and-drop and the browser attachment picker also extract
PDF/Word content. Wait for the reading message to finish, type your request, and
send. For example: “Summarize this document. List deadlines, pending work, and
responsible people, with PDF page references.”

The document contents appear in the draft so you can review what will be sent.
Your selected model/provider handles that text. Select a local Ollama model if
the document must stay on the laptop. Extraction and OCR run locally and do not
require Microsoft Word, Python, a GPU, or an online OCR service.

Word paragraphs and table text are extracted. Text PDFs retain page references.
Pages with little or no text use bundled English OCR. Check OCR warnings and
verify figures, tables, handwriting, and complex layouts against the original.
Word documents containing only images currently report that no readable text
was found. Older `.doc` files must first be saved as `.docx`.

Limits: 25 MB per file, 100 PDF pages, 120,000 extracted characters per document,
and five documents per batch. Larger files are rejected explicitly; no document
is silently cut off. These parser limits are not a promise that a small model
can handle the entire document in one request. Use smaller documents for small
context windows; long-document map/reduce summarization is not implemented.

Scanned PDFs take longer because OCR reads each page on CPU. Document extraction
does not remove the model's existing tool catalog or change its writing mode.
