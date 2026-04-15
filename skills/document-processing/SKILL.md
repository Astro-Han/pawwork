---
name: document-processing
description: Use when user wants to create, edit, convert, or extract from Word, Excel, PowerPoint, or PDF files
---

# Document Processing

Handle document creation, editing, conversion, and extraction for local office files.

<GATE>
Do NOT start working on files until you understand what the user needs. Ask clarifying questions first, then act.
</GATE>

## Workflow

1. **Clarify** - Ask the user what they need before touching any files.
2. **Execute** - Choose the least-destructive toolchain, then perform the task.
3. **Verify** - Check the output against the user's constraints and report the result.

## Step 1: Clarify

Ask the user the following before acting:

- **Task type** — Are they creating a new document, editing an existing one, converting between formats, or extracting content?
- **Source** — Will they upload or specify files, or should you reuse files from a previous step?
- **Constraints** — Anything that must stay unchanged: layout, formulas, comments, branding, slide order.

## Step 2: Execute

| Format or task | Tool |
| --- | --- |
| docx, xlsx, pptx | `officecli` |
| PDF merge, split, fill, extract | `pdf-lib` |
| Mixed formats | Decide the final output format first, then use the safest path |

Execution rules:
- Inspect the source files before editing or converting them.
- Prefer edits that preserve the original structure over destructive conversions.
- If a conversion risks losing formulas, layout, comments, or branding, explain the tradeoff before finalizing.
- Save the output in the current workspace unless the user gave a different path.

## Step 3: Verify

Before reporting back:
- Confirm the output file exists and is in the expected format.
- Check the requested constraints, such as layout, formulas, branding, or extracted sections.
- If fidelity is uncertain, say exactly what could not be verified.
- Report what changed and where the output was saved.

## Language

Reply in the user's locale (shown in system environment as "User locale").
If no locale is shown, match the language used in the user's request.
