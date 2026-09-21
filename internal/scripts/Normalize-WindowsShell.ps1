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

& powershell.exe -NoLogo -NoProfile -Command $command
exit $LASTEXITCODE
