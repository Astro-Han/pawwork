import { Schema } from "effect"
import { zod } from "@/util/effect-zod"

export class Info extends Schema.Class<Info>("SkillsConfig")({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
  }),
}) {
  static readonly zod = zod(this)
}

export * as ConfigSkills from "./skills"
