export async function submitProviderApiAuth(input: {
  setAuth: () => Promise<unknown>
  onComplete: () => Promise<void>
  formatError: (error: unknown) => string
}) {
  const result = await input
    .setAuth()
    .then(() => ({ ok: true as const }))
    .catch((error) => ({ ok: false as const, error }))
  if (result.ok) {
    await input.onComplete()
    return
  }
  return input.formatError(result.error)
}
