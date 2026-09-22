[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$InternalRoot = Split-Path -Parent $PSScriptRoot
$Root = Split-Path -Parent $InternalRoot
$Source = Join-Path $InternalRoot "launcher\DevRelayLauncher.cs"
$Icon = Join-Path $InternalRoot "assets\devrelay-icon.ico"
$Output = Join-Path $Root "DevRelay.exe"

$candidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw "The Windows .NET Framework C# compiler was not found." }
if (-not (Test-Path -LiteralPath $Source)) { throw "Launcher source is missing: $Source" }
if (-not (Test-Path -LiteralPath $Icon)) { throw "Launcher icon is missing: $Icon" }

& $csc /nologo /target:winexe /optimize+ /platform:anycpu `
  "/win32icon:$Icon" `
  "/out:$Output" `
  $Source
if ($LASTEXITCODE -ne 0) { throw "DevRelay launcher compilation failed with code $LASTEXITCODE." }

Write-Host "Built $Output"
