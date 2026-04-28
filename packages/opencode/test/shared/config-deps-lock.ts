let tail = Promise.resolve()

export async function withConfigDepsLock<T>(fn: () => Promise<T>): Promise<T> {
  const turn = tail
  let release!: () => void
  tail = new Promise<void>((resolve) => {
    release = resolve
  })

  await turn
  try {
    return await fn()
  } finally {
    release()
  }
}
