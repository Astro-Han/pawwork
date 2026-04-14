---
name: document-processing
description: Handle Word, Excel, PowerPoint, PDF, and mixed office-file requests.
---

# Document Processing

Use this skill when the user wants to create, edit, convert, clean up, or extract information from office documents.

## Scene Detection

- Use for docx, xlsx, pptx, pdf, or mixed office-file workflows.
- Do not use for pure writing requests without source files. Route those to `writing-assistant`.
- Do not guess the target format from the input extension alone. Follow the requested output.

## AskUserQuestion Flow

Use AskUserQuestion to collect the missing execution constraints before touching files. Ask for:

1. Which file or files are the source material?
2. What output format do they want, docx, xlsx, pptx, pdf, or plain text?
3. Is this a new file, an edit to an existing file, or a conversion?
4. What must stay unchanged, layout, formulas, page order, wording, or branding?

If any of those are missing and the wrong choice would change the output, stop and ask before proceeding.

## Workflow

1. Inspect the source files and confirm the requested output.
2. Choose the least-destructive toolchain for that file type.
3. Make the edit or conversion.
4. Verify the output exists and still matches the non-negotiable constraints.
5. Report exactly what changed and where the file was written.

## Tool Rules

- Prefer `officecli` for docx, xlsx, and pptx read or write tasks.
- Use `pdf-lib` only for PDF-specific work, merge, split, reorder, fill, stamp, or extract.
- If the request mixes office files and PDF, decide the final output format before editing.
- If the input is ambiguous, ask before editing the wrong file.
- When creating output, save it inside the current PawWork workspace unless the user gives a different path.

## Error Handling and Degradation

- If formatting fidelity is uncertain, warn before you finalize.
- If a requested conversion would destroy formulas, layout, comments, or pagination, explain the tradeoff and offer a safer alternative.
- If a file cannot be parsed by the preferred tool, say which file failed and switch to the closest safe fallback instead of silently skipping it.

## Output Requirements

- Say which file you created or changed.
- If formatting fidelity is uncertain, warn the user before finishing.
- If a requested conversion cannot preserve structure, offer the closest safe alternative.
