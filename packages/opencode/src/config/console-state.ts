import { Schema } from "effect"
import { zod } from "@/util/effect-zod"

export class ConsoleState extends Schema.Class<ConsoleState>("ConsoleState")({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optional(Schema.String),
  switchableOrgCount: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
}) {
  static readonly zod = zod(this)
}

export const emptyConsoleState: ConsoleState = ConsoleState.make({
  consoleManagedProviders: [],
  activeOrgName: undefined,
  switchableOrgCount: 0,
})
