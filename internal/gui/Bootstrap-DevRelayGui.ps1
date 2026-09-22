[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$GuiRoot = $PSScriptRoot
$InternalRoot = Split-Path -Parent $GuiRoot
$UpdateScript = Join-Path $InternalRoot "scripts\Update-DevRelayFromRelease.ps1"
$GuiScript = Join-Path $GuiRoot "devrelay-gui.mjs"
$SetupStateScript = Join-Path $GuiRoot "setup\setup-state.mjs"
$SetupWizardScript = Join-Path $GuiRoot "setup\setup-wizard.mjs"

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

  & $node.Source $SetupStateScript $InternalRoot | Out-Null
  $setupCode = $LASTEXITCODE
  if ($setupCode -eq 10) {
    & $node.Source $SetupWizardScript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $node.Source $SetupStateScript $InternalRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 0 }
  } elseif ($setupCode -ne 0) {
    throw "DevRelay setup-state check failed with code $setupCode."
  }

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
