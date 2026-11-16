# PawWork sidebar and custom skills

Open **PawWork Sidepop** from the desktop once. It also starts at Windows sign-in.
Open a real folder in File Explorer, make that Explorer window active, then press
**Ctrl+Alt+A**. PawWork opens and selects that folder. For a new folder, approve
the folder-access prompt shown above the sidebar. Explorer Home and This PC do not represent file folders.
You can also use **Choose folder…** in the sidebar header.

## Add a skill for the selected project

Inside the project folder, create `.agents/skills/file-change-notes/SKILL.md`.
For Git projects, place `.agents` at the repository root. The file must be named
`SKILL.md`, not `SKILL.md.txt`. Paste this example:

```markdown
---
name: file-change-notes
description: Keep a concise record of requested file changes in workspace memory.
---

After making file changes requested by the user:
1. Preserve the existing contents of memory.md in the workspace root.
2. Append the date, filenames changed, and a short explanation of each change.
3. Do not modify unrelated files.
4. Report the changes and where the notes were saved.
```

Select that project in PawWork, then ask:
**Use the file-change-notes skill for this task.**
PawWork watches skill files for changes. If a new skill does not appear,
start a new chat in the selected project or restart PawWork.

For a skill available in every project, use
`%USERPROFILE%\.agents\skills\file-change-notes\SKILL.md` instead.
To add a downloaded skill, copy its entire folder, including any scripts and
references, into the project or user skills directory. Review its instructions
and scripts before using it.
