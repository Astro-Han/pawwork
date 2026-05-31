export function shouldRunNativeWatcherTests(
  hasNativeBinding: () => boolean,
  env: Record<string, string | undefined> = process.env,
) {
  return !env.CI && hasNativeBinding()
}
