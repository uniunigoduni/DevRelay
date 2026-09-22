[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$GuiRoot = $PSScriptRoot
$InternalRoot = Split-Path -Parent $GuiRoot
$UpdateScript = Join-Path $InternalRoot "scripts\Update-DevRelayFromRelease.ps1"
$GuiScript = Join-Path $GuiRoot "devrelay-gui.mjs"

$mutex = New-Object Threading.Mutex($false, "Local\DevRelayGuiBootstrap")
$ownsMutex = $false
try {
  $ownsMutex = $mutex.WaitOne(0)
  if (-not $ownsMutex) { exit 0 }

  try {
    $existing = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:7318/api/state" -TimeoutSec 1
    if ($existing.StatusCode -eq 200) { exit 0 }
  } catch { }

  if (Test-Path -LiteralPath $UpdateScript) {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $UpdateScript | Out-Null
  }

  $node = Get-Command node.exe -ErrorAction Stop
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $node.Source
  $startInfo.Arguments = '"' + $GuiScript.Replace('"', '\"') + '"'
  $startInfo.WorkingDirectory = $InternalRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  [void][Diagnostics.Process]::Start($startInfo)
} finally {
  if ($ownsMutex) { try { $mutex.ReleaseMutex() } catch { } }
  $mutex.Dispose()
}
