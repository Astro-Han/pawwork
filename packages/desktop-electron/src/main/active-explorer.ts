import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { validWorkspaceDirectory } from "./launch-workspace"

const execFileAsync = promisify(execFile)

// Shell.Application reports every Explorer tab, including background tabs.
// The foreground window title begins with the selected tab's LocationName.
const foregroundExplorerScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -Namespace PawWork -Name Window -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetWindowText(System.IntPtr hwnd, System.Text.StringBuilder text, int count);
'@
$hwnd = [PawWork.Window]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { exit }
$caption = [System.Text.StringBuilder]::new(512)
[PawWork.Window]::GetWindowText($hwnd, $caption, $caption.Capacity) | Out-Null
[Console]::Out.WriteLine('PAWWORK_FOREGROUND_CAPTURED')
[Console]::Out.Flush()
$tabs = @()
$shell = New-Object -ComObject Shell.Application
foreach ($window in $shell.Windows()) {
  try {
    if ([Int64]$window.HWND -ne $hwnd.ToInt64()) { continue }
    if ([System.IO.Path]::GetFileName([string]$window.FullName) -ine 'explorer.exe') { continue }
    $folder = [string]$window.Document.Folder.Self.Path
    if ($folder) { $tabs += @{ name = [string]$window.LocationName; path = $folder } }
  } catch { }
}
@{ title = $caption.ToString(); tabs = @($tabs) } | ConvertTo-Json -Compress -Depth 3
`

type ExplorerTab = { name: string; path: string }
type ExplorerSnapshot = { title: string; tabs: ExplorerTab[] }

export function folderFromExplorerSnapshot(snapshot: ExplorerSnapshot): string | undefined {
  if (!snapshot || !Array.isArray(snapshot.tabs)) return undefined
  const folders = snapshot.tabs.flatMap((tab) => {
    const path = validWorkspaceDirectory(tab.path)
    return path && typeof tab.name === "string" ? [{ name: tab.name, path }] : []
  })
  if (folders.length === 1) return folders[0]!.path
  const title = typeof snapshot.title === "string" ? snapshot.title.toLocaleLowerCase() : ""
  const matches = folders.filter(({ name }) => {
    const label = name.toLocaleLowerCase()
    return label && title.startsWith(label) && (title.length === label.length || /[\s–-]/u.test(title[label.length]!))
  }).sort((a, b) => b.name.length - a.name.length)
  if (!matches.length || (matches[1] && matches[0]!.name.length === matches[1].name.length)) return undefined
  return matches[0]!.path
}

export async function foregroundExplorerDirectory(onCaptured?: () => void): Promise<string | undefined> {
  let revealed = false
  const reveal = () => {
    if (revealed) return
    revealed = true
    onCaptured?.()
  }
  if (process.platform !== "win32") { reveal(); return undefined }
  try {
    const encoded = Buffer.from(foregroundExplorerScript, "utf16le").toString("base64")
    const pending = execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
    let output = ""
    pending.child.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString()
      // Capture the Explorer window before revealing PawWork steals focus.
      if (output.includes("PAWWORK_FOREGROUND_CAPTURED")) reveal()
    })
    const { stdout } = await pending
    const snapshot = stdout.replace("PAWWORK_FOREGROUND_CAPTURED", "").trim()
    return snapshot ? folderFromExplorerSnapshot(JSON.parse(snapshot) as ExplorerSnapshot) : undefined
  } catch {
    return undefined
  } finally {
    reveal()
  }
}
