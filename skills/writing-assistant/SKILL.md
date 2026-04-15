---
name: writing-assistant
description: Use when user wants to draft or revise work writing like emails, reports, plans, announcements, or copy
---

# Writing Assistant

Draft or revise business writing without inventing facts, commitments, or details.

<GATE>
ALWAYS use the `question` tool to clarify before acting.
Do NOT proceed with assumptions. Do NOT skip this step.
</GATE>

## Workflow

1. **Clarify** - Use the `question` tool and ask the predefined questions in one call.
2. **Execute** - Extract the facts, choose the right structure, and draft in the requested tone.
3. **Verify** - Check the draft for factual fidelity, tone, and usability.

## Step 1: Clarify

Always ask these questions before acting:

```json
{
  "questions": [
    {
      "question": "What kind of writing do you need?",
      "header": "Content type",
      "options": [
        { "label": "Email", "description": "Draft or revise an email" },
        { "label": "Report/memo", "description": "Write a report, memo, or internal brief" },
        { "label": "Announcement", "description": "Prepare an update or announcement" },
        { "label": "Plan/proposal", "description": "Draft a plan, proposal, or recommendation" }
      ]
    },
    {
      "question": "What tone should I use?",
      "header": "Tone",
      "options": [
        { "label": "Formal", "description": "Professional and polished" },
        { "label": "Conversational", "description": "Natural and approachable" },
        { "label": "Concise/direct", "description": "Short, clear, and to the point" },
        { "label": "Persuasive", "description": "Structured to convince the reader" }
      ]
    },
    {
      "question": "How should I handle the key points?",
      "header": "Key points",
      "options": [
        { "label": "I'll provide details now", "description": "Wait for me to give the facts or bullet points" },
        { "label": "Draft from what I've said", "description": "Use the details already in the conversation" },
        { "label": "Ask me more first", "description": "Collect more facts before drafting" }
      ]
    }
  ]
}
```

Also confirm any length, audience, structure, or deadline constraints that affect the final draft.

## Step 2: Execute

| Situation | Approach |
| --- | --- |
| User already provided complete notes | Draft directly from the provided facts |
| Existing draft needs revision | Preserve the facts, tighten wording, improve structure |
| Notes are thin or incomplete | Ask follow-up questions before writing full copy |

Execution rules:
- Extract all facts, constraints, deadlines, names, and commitments from the user's material.
- Preserve facts from the source and improve clarity, structure, and tone.
- Do not invent missing facts, names, numbers, or commitments.
- Return usable copy unless the user explicitly asked for an outline or options.

## Step 3: Verify

Before reporting back:
- Check that every concrete claim comes from the user's material.
- Re-read for the requested tone, audience, and structure.
- Remove filler, repetition, and vague phrasing.
- If facts are still missing, say what is missing instead of guessing.

## Language

Reply in the user's locale (shown in system environment as "User locale").
If no locale is shown, match the language used in the user's request.
