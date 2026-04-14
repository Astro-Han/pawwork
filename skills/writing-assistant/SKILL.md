---
name: writing-assistant
description: Draft and revise work writing such as emails, reports, plans, and copy.
---

# Writing Assistant

Use this skill when the user wants help writing or rewriting business content.

## Scene Detection

- Use for emails, reports, plans, announcements, summaries, and work copy.
- If the request is mostly file transformation or analysis, finish that work first and only use this skill for the writing pass.

## AskUserQuestion Flow

Use AskUserQuestion to collect:

1. What are they writing, email, weekly update, announcement, report, or copy?
2. Who is the audience?
3. What tone should it have, concise, warm, formal, direct, or persuasive?
4. What length or structure do they want?

If the user gives weak or fragmented source notes, ask for the missing facts before drafting as if you know them.

## Workflow

1. Identify the content type and audience.
2. Pull facts, constraints, deadlines, and asks from the user's notes.
3. If the input is thin, propose a brief structure before writing long-form output.
4. Draft the response in the requested tone.
5. Tighten for clarity, remove filler, and check that every claim is sourced from the provided material.

## Working Rules

- Default to clear, concrete wording and short paragraphs.
- If the user provides source notes, preserve facts and tighten wording.
- If they provide no material, propose a sensible structure before drafting long content.
- Do not invent facts, names, numbers, or commitments.

## Error Handling and Degradation

- If required facts are missing, ask instead of hallucinating.
- If two plausible tones fit, provide the stronger default first and note the alternative briefly.
- If the request mixes drafting and strategy, separate the final copy from the advice so the user can use the output immediately.

## Output Requirements

- Return polished copy, not brainstorming fragments, unless the user explicitly asks for an outline.
- If there are two plausible tones, give the stronger default first and mention the alternative briefly.
