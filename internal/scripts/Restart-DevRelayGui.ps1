[CmdletBinding()]
param(
  [ValidateRange(250, 10000)][int]$DelayMs = 1500,
  [ValidateRange(5, 60)][int]$TimeoutSeconds = 20,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$InternalRoot = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $InternalRoot
$LaunchVbs = Join-Path $InternalRoot "gui\launch.vbs"

if (-not (Test-Path -LiteralPath $LaunchVbs)) { throw "GUI launcher not found: $LaunchVbs" }

$controller = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq "node.exe" -and $_.CommandLine -and
  $_.CommandLine.IndexOf("devrelay-gui.mjs", [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine.IndexOf($InternalRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
} | Select-Object -First 1

if ($DryRun) {
  [pscustomobject]@{
    ok = $true
    projectRoot = $ProjectRoot
    controllerPid = if ($controller) { [int]$controller.ProcessId } else { $null }
    launchVbs = $LaunchVbs
  } | ConvertTo-Json -Compress
  exit 0
}

$helperPath = Join-Path ([IO.Path]::GetTempPath()) ("DevRelay-Restart-" + [Guid]::NewGuid().ToString("N") + ".ps1")
$helper = @'
param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [int]$ControllerPid = 0,
  [int]$DelayMs = 1500,
  [int]$TimeoutSeconds = 20
)
$ErrorActionPreference = "SilentlyContinue"
Start-Sleep -Milliseconds $DelayMs
$internal = Join-Path $ProjectRoot "internal"
$hostScript = Join-Path $internal "gui\host\DevRelay-GuiHost.ps1"
$launchVbs = Join-Path $internal "gui\launch.vbs"

$hosts = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq "powershell.exe" -and $_.CommandLine -and
  $_.CommandLine.IndexOf($hostScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
foreach ($hostInfo in $hosts) {
  $hostPid = [int]$hostInfo.ProcessId
  $process = Get-Process -Id $hostPid -ErrorAction SilentlyContinue
  $closeRequested = $false
  if ($process) {
    try { $closeRequested = [bool]$process.CloseMainWindow() } catch {}
  }
  if ($closeRequested) {
    $hostDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $hostDeadline -and (Get-Process -Id $hostPid -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 100
    }
  }
  if (Get-Process -Id $hostPid -ErrorAction SilentlyContinue) {
    # Tell the controller this is an intentional GUI close before using the
    # last-resort force termination path.
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:7318/api/stop" -Method Post `
        -Headers @{ Origin = "http://127.0.0.1:7318" } -ContentType "application/json" `
        -Body '{"reason":"window closed"}' -TimeoutSec 4 | Out-Null
    } catch {}
    Stop-Process -Id $hostPid -Force -ErrorAction SilentlyContinue
  }
}

if ($ControllerPid -gt 0) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline -and (Get-Process -Id $ControllerPid -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 200
  }
  if (Get-Process -Id $ControllerPid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $ControllerPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
}

Start-Process -FilePath "wscript.exe" -ArgumentList @("//nologo", ('"' + $launchVbs + '"')) -WindowStyle Hidden
Start-Sleep -Seconds 1
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
'@
[IO.File]::WriteAllText($helperPath, $helper, (New-Object Text.UTF8Encoding($false)))

$controllerPid = if ($controller) { [int]$controller.ProcessId } else { 0 }
function Quote-Argument([string]$Value) { return '"' + $Value.Replace('"', '""') + '"' }
$commandLine = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $(Quote-Argument $helperPath) -ProjectRoot $(Quote-Argument $ProjectRoot) -ControllerPid $controllerPid -DelayMs $DelayMs -TimeoutSeconds $TimeoutSeconds"
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
if ([int]$created.ReturnValue -ne 0) {
  Remove-Item -LiteralPath $helperPath -Force -ErrorAction SilentlyContinue
  throw "Failed to hand off GUI restart. Win32_Process.Create returned $($created.ReturnValue)."
}

[pscustomobject]@{ ok = $true; helperPid = [int]$created.ProcessId; controllerPid = $controllerPid } | ConvertTo-Json -Compress
