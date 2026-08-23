param(
  [Parameter(Mandatory = $true)]
  [int]$TargetProcessId,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class PawWorkWindowCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr window, out Rect rect);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr window);
}
"@

$process = Get-Process -Id $TargetProcessId
for ($attempt = 0; $attempt -lt 50 -and $process.MainWindowHandle -eq [IntPtr]::Zero; $attempt++) {
  Start-Sleep -Milliseconds 100
  $process.Refresh()
}

$window = $process.MainWindowHandle
if ($window -eq [IntPtr]::Zero) {
  throw "Process $TargetProcessId has no main window"
}

[void][PawWorkWindowCapture]::SetForegroundWindow($window)
Start-Sleep -Milliseconds 250
$rect = New-Object PawWorkWindowCapture+Rect
if (-not [PawWorkWindowCapture]::GetWindowRect($window, [ref]$rect)) {
  throw "Could not read the PawWork window bounds"
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  throw "PawWork window has invalid bounds ${width}x${height}"
}

$directory = [System.IO.Path]::GetDirectoryName($OutputPath)
[System.IO.Directory]::CreateDirectory($directory) | Out-Null
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
