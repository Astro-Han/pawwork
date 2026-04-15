---
name: document-processing
description: Use when user wants to create, edit, convert, or extract from Word, Excel, PowerPoint, or PDF files
---

# Document Processing

Handle document creation, editing, conversion, and extraction for local office files.

<GATE>
ALWAYS use the `question` tool to clarify before acting.
Do NOT proceed with assumptions. Do NOT skip this step.
</GATE>

## Workflow

1. **Clarify** - Use the `question` tool and ask the predefined questions in one call.
2. **Execute** - Choose the least-destructive toolchain, then perform the task.
3. **Verify** - Check the output against the user's constraints and report the result.

## Step 1: Clarify

Always ask these questions before acting:

```json
{
  "questions": [
    {
      "question": "What type of document task do you need?",
      "header": "Task type",
      "options": [
        { "label": "Create new", "description": "Create a new document from scratch" },
        { "label": "Edit existing", "description": "Modify an existing file" },
        { "label": "Convert format", "description": "Convert a file into another format" },
        { "label": "Extract content", "description": "Pull text, tables, slides, or other content from a file" }
      ]
    },
    {
      "question": "Where should I get the source material?",
      "header": "Source",
      "options": [
        { "label": "I'll upload/specify files", "description": "I will name or upload the source files for this task" },
        { "label": "Use files from a previous step", "description": "Reuse files already created or referenced earlier in this session" }
      ]
    }
  ]
}
```

Also confirm any output constraints that must stay unchanged, such as layout, formulas, comments, branding, or slide order.

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
