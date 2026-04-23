---
name: writing-assistant
description: Use when user wants to draft or revise work writing like emails, reports, plans, announcements, or copy
---

# Writing Assistant

Draft or revise business writing without inventing facts, commitments, or details.

<GATE>
Do NOT start drafting until you understand the user's goal, audience, and source material well enough to avoid inventing facts.

When important context is missing, use the `question` tool instead of asking only in plain text. Ask a focused round of questions, typically 2-4, and ask fewer when only one material gap is missing. Ask deeper, non-obvious questions that uncover the user's goal, audience, tone, constraints, and tradeoffs. Provide your recommended answer as the first option when useful. Use multiple selection when several tones, channels, or output formats may be acceptable.

Do not ask obvious questions whose answers are already in the user's message. Stop asking once you can produce a useful first draft. Ask another focused round only if the user's answer reveals a material gap.

Before asking, use this decision rule:
- **Must ask** when the missing answer changes the audience, purpose, factual claims, commitments, deadline, channel, or reader action.
- **Use a recommended default and continue** when the missing answer is only a preference, such as exact length, minor tone choice, or whether to include a subject line.
- **Ask one multiple-choice question** when several safe drafts are possible. Put the recommended default first and explain why it is recommended.
</GATE>

## Workflow

1. **Clarify** - Use focused questions to understand what the writing needs to achieve before writing anything.
2. **Execute** - Extract the facts, choose the right structure, and draft in the requested tone.
3. **Verify** - Check the draft for factual fidelity, tone, and usability.

## Step 1: Clarify

Use the question tool to ask what matters before acting:

- **Content type**: Email, report or memo, announcement, or plan/proposal?
- **Tone**: Formal, conversational, concise and direct, or persuasive?
- **Key points**: Will they provide details now, should you draft from what they already said, or should you ask more questions first? Ask only when the answer would materially change the draft.
- **Constraints**: Any length, audience, structure, or deadline requirements.
- **Success check**: What should the reader think, decide, or do after reading?

If the user chooses to provide details later, wait for their next message before proceeding to draft.

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
