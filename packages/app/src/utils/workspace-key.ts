export const workspaceKey = (directory: string) => {
  const value = directory.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (drive) => drive.toUpperCase())
  const drive = value.match(/^([A-Z]:)\/+$/)
  if (drive) return `${drive[1]}/`
  if (/^\/+$/i.test(value)) return "/"
  return value.replace(/\/+$/, "")
}
