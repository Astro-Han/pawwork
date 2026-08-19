export const PAWWORK_APP = {
  dev: { id: "ai.pawwork.desktop.dev", name: "PawWork Dev" },
  beta: { id: "ai.pawwork.desktop.beta", name: "PawWork Beta" },
  prod: { id: "ai.pawwork.desktop", name: "PawWork" },
} as const

export type PawWorkChannel = keyof typeof PAWWORK_APP
