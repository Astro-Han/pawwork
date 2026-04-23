---
name: document-processing
description: Use when user wants to create, edit, convert, or extract from Word, Excel, PowerPoint, or PDF files
---

# Document Processing

Handle document creation, editing, conversion, and extraction for local office files.

<GATE>
Do NOT start working on files until you understand what the user needs and what must be preserved.

When important context is missing, use the `question` tool instead of asking only in plain text. Ask a focused round of questions, typically 2-4, and ask fewer when only one material gap is missing. Ask deeper, non-obvious questions that uncover the user's goal, source material, constraints, and tradeoffs. Provide your recommended answer as the first option when useful. Use multiple selection when several operations or output formats may be needed.

Do not ask obvious questions whose answers are already in the user's message. Stop asking once you can produce a useful first output safely. Ask another focused round only if the user's answer reveals a material gap.

Before asking, use this decision rule:
- **Must ask** when the missing answer changes the source file, target format, editing scope, layout fidelity, formulas, comments, permissions, or overwrite risk.
- **Use a recommended default and continue** when the missing answer is only a preference, such as file name, minor formatting, or whether to include a short note with the output.
- **Ask one multiple-choice question** when several safe paths are possible. Put the recommended default first and explain why it is recommended.
</GATE>

## Workflow

1. **Clarify** - Use focused questions to understand the task and constraints before touching any files.
2. **Execute** - Choose the least-destructive toolchain, then perform the task.
3. **Verify** - Check the output against the user's constraints and report the result.

## Step 1: Clarify

Use the question tool to ask what matters before acting:

- **Task type**: Are they creating a new document, editing an existing one, converting between formats, or extracting content?
- **Source**: Will they upload or specify files, or should you reuse files from a previous step?
- **Constraints**: Anything that must stay unchanged: layout, formulas, comments, branding, slide order.
- **Success check**: What should the finished file let the user do: send it, review it, import it, print it, or keep editing it?

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
