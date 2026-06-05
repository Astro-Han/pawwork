// Presentation helpers for the Skills gallery. Skills are rendered straight from
// their own universal format (name + description); there is no curation layer.

export interface SkillInfo {
  name: string
  description?: string
  location: string
  content: string
}

// `officecli-docx` -> `Officecli Docx`. Split on - and _, capitalize each word.
export function skillTitle(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ")
}

// Case-insensitive match across title, raw name, and description.
export function skillMatches(skill: SkillInfo, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    skill.name.toLowerCase().includes(needle) ||
    skillTitle(skill.name).toLowerCase().includes(needle) ||
    (skill.description?.toLowerCase().includes(needle) ?? false)
  )
}
