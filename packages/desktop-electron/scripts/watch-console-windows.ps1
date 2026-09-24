param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [Parameter(Mandatory = $true)]
  [string]$StopPath
)

# Writes one JSON line per top-level window or console-related process that
# appears after start, until StopPath exists.

$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PawWorkConsoleWatch {
  delegate bool EnumWindowsProc(IntPtr window, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);

  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr window);

  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  public class Window {
    public long Handle;
    public string ClassName;
    public string Title;
    public bool Visible;
    public uint ProcessId;
  }

  public static List<Window> List() {
    var windows = new List<Window>();
    EnumWindows((window, lParam) => {
      var name = new StringBuilder(256);
      GetClassName(window, name, name.Capacity);
      var title = new StringBuilder(256);
      GetWindowText(window, title, title.Capacity);
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      windows.Add(new Window {
        Handle = window.ToInt64(),
        ClassName = name.ToString(),
        Title = title.ToString(),
        Visible = IsWindowVisible(window),
        ProcessId = processId,
      });
      return true;
    }, IntPtr.Zero);
    return windows;
  }
}
"@

$consoleProcessNames = @("conhost.exe", "OpenConsole.exe", "WindowsTerminal.exe", "pwsh.exe", "powershell.exe", "cmd.exe")
$seenWindows = @{}
$seenProcesses = @{}
foreach ($window in [PawWorkConsoleWatch]::List()) { $seenWindows[$window.Handle] = $window.Visible }
foreach ($process in Get-CimInstance Win32_Process) { $seenProcesses[[int]$process.ProcessId] = $true }

function Write-Event($record) {
  [System.IO.File]::AppendAllText($OutputPath, ($record | ConvertTo-Json -Compress) + "`n")
}

function Get-ProcessName([uint32]$processId) {
  try { return (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { return "" }
}

[System.IO.File]::WriteAllText($OutputPath, "")
Write-Event @{ kind = "ready"; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
while (-not (Test-Path -LiteralPath $StopPath)) {
  $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  foreach ($window in [PawWorkConsoleWatch]::List()) {
    $known = $seenWindows.ContainsKey($window.Handle)
    # A window created hidden and shown later is reported again when it turns visible.
    if ($known -and ($seenWindows[$window.Handle] -or -not $window.Visible)) { continue }
    $seenWindows[$window.Handle] = $window.Visible
    Write-Event @{
      kind = "window"
      at = $at
      handle = $window.Handle
      className = $window.ClassName
      title = $window.Title
      visible = $window.Visible
      processId = $window.ProcessId
      processName = Get-ProcessName $window.ProcessId
    }
  }
  foreach ($process in Get-CimInstance Win32_Process) {
    $processId = [int]$process.ProcessId
    if ($seenProcesses.ContainsKey($processId)) { continue }
    $seenProcesses[$processId] = $true
    if ($consoleProcessNames -notcontains $process.Name) { continue }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)" -ErrorAction SilentlyContinue
    Write-Event @{
      kind = "process"
      at = $at
      processId = $processId
      name = $process.Name
      parentProcessId = [int]$process.ParentProcessId
      parentName = if ($parent) { $parent.Name } else { "" }
      parentCommandLine = if ($parent) { $parent.CommandLine } else { "" }
      commandLine = $process.CommandLine
    }
  }
  Start-Sleep -Milliseconds 100
}
