export function getRuntimeFlags(env: NodeJS.ProcessEnv) {
  return {
    ciSmokeEnabled: env.PAWWORK_CI_SMOKE === "true",
  }
}
