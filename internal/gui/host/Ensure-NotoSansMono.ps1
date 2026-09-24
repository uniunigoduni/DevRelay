[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-NotoSansMono {
  Add-Type -AssemblyName System.Drawing
  $fonts = New-Object System.Drawing.Text.InstalledFontCollection
  return @($fonts.Families | ForEach-Object Name | Where-Object { $_ -eq "Noto Sans Mono" }).Count -gt 0
}

if (Test-NotoSansMono) { exit 0 }
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$fontPath = Join-Path $Root "NotoSansMono.ttf"
if (-not (Test-Path $fontPath)) {
  $uri = "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansmono/NotoSansMono%5Bwdth,wght%5D.ttf"
  Invoke-WebRequest -Uri $uri -OutFile $fontPath
}

$userFonts = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts"
New-Item -ItemType Directory -Force -Path $userFonts | Out-Null
$installedPath = Join-Path $userFonts "NotoSansMono-Variable.ttf"
Copy-Item -LiteralPath $fontPath -Destination $installedPath -Force
$fontKey = "HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"
New-Item -Path $fontKey -Force | Out-Null
New-ItemProperty -Path $fontKey -Name "Noto Sans Mono (TrueType)" -Value $installedPath -PropertyType String -Force | Out-Null
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DevRelayFontBroadcast {
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern int AddFontResourceEx(string file, uint flags, IntPtr reserved);
  [DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
$added = [DevRelayFontBroadcast]::AddFontResourceEx($installedPath, 0, [IntPtr]::Zero)
$result = [UIntPtr]::Zero
[void][DevRelayFontBroadcast]::SendMessageTimeout(
  [IntPtr]0xffff, 0x001D, [UIntPtr]::Zero, [IntPtr]::Zero,
  0x0002, 1000, [ref]$result)

if (-not (Test-NotoSansMono)) {
  Write-Warning "Noto Sans Mono was installed for the current user but may require a new Windows session before discovery."
}
exit 0