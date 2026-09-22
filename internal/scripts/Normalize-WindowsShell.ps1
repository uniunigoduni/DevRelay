param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('cmd','powershell')]
  [string]$Mode,
  [Parameter(Mandatory=$true)]
  [string]$CommandBase64
)

$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CommandBase64))

if ($Mode -eq 'cmd') {
  & $env:ComSpec /d /s /c $command
  exit $LASTEXITCODE
}

$stateRoot = Join-Path (Split-Path $PSScriptRoot -Parent) '.devrelay\powershell-temp'
[IO.Directory]::CreateDirectory($stateRoot) | Out-Null
$tempPath = Join-Path $stateRoot ('command-' + [Guid]::NewGuid().ToString('N') + '.ps1')

$prefix = @'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
'@
$footer = @'
if ($?) { exit 0 }
exit 1
'@
$scriptText = $prefix + "`r`n" + $command + "`r`n" + $footer + "`r`n"

try {
  [IO.File]::WriteAllText($tempPath, $scriptText, [Text.Encoding]::Unicode)
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $tempPath
  $exitCode = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
}

exit $exitCode
