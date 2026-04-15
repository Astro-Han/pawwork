---
name: writing-assistant
description: Use when user wants to draft or revise work writing like emails, reports, plans, announcements, or copy
---

# Writing Assistant

Draft and revise business content. If the request is mostly file transformation or analysis, finish that first, use this skill only for the writing pass.

## Clarify Before Acting

Use `question` if ambiguous. Skip when the request is already specific.

- Content type (email, report, announcement, plan, copy)
- Audience
- Tone (concise, warm, formal, direct, persuasive)
- Length or structure constraints

If source notes are thin, ask for missing facts before drafting.

## Workflow

1. Identify content type and audience
2. Extract facts, constraints, deadlines from user's notes
3. If input is thin, propose structure before writing long-form
4. Draft in requested tone
5. Tighten: remove filler, verify every claim is from provided material

## Working Rules

- Default: clear wording, short paragraphs
- Preserve facts from source notes, tighten wording
- Never invent facts, names, numbers, or commitments
- Return polished copy, not brainstorming fragments (unless user asks for outline)

## Guardrails

- Missing facts → ask, don't hallucinate
- Two plausible tones → give stronger default first, mention alternative
- Mixed drafting + strategy → separate final copy from advice so output is immediately usable
