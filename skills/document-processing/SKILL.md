---
name: document-processing
description: Use when user wants to create, edit, convert, or extract from Word, Excel, PowerPoint, or PDF files
---

# Document Processing

Process office documents: docx, xlsx, pptx, pdf, csv. Pure writing requests without source files → `writing-assistant`.

## Clarify Before Acting

Use `question` if ambiguous. Skip when the request is already specific.

- Source file(s) and target format
- New file, edit, or conversion
- What must stay unchanged (layout, formulas, branding)

## Tool Selection

| Format | Tool |
|--------|------|
| docx, xlsx, pptx | `officecli` |
| PDF merge/split/fill/extract | `pdf-lib` |
| Mixed formats | Decide final output format first |

## Workflow

1. Inspect source files, confirm requested output
2. Choose least-destructive toolchain for the file type
3. Make the edit or conversion
4. Verify output matches constraints
5. Report what changed and where the file was saved

## Guardrails

- Conversion would destroy formulas/layout/comments → explain tradeoff, offer alternative
- Formatting fidelity uncertain → warn before finalizing
- File can't be parsed → name the file, switch to closest safe fallback
- Save output in current workspace unless user specifies a path
