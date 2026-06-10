import { useSurfacePage } from "@/pages/layout/surface-page-context"
import { SkillsSurface } from "./skills-surface"

// /skills route.
export default function SkillsRoute() {
  const surface = useSurfacePage()
  return <SkillsSurface directory={surface.skills.directory} onClose={surface.close} onUseSkill={surface.skills.useInChat} />
}
