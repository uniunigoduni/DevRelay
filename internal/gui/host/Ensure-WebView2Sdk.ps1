[CmdletBinding()]
param(
  [string]$Root,
  [string]$Version = "1.0.4191.47"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Root)) {
  throw "Root is required."
}

$core = Join-Path $Root "package\lib\net462\Microsoft.Web.WebView2.Core.dll"
$wpf = Join-Path $Root "package\lib\net462\Microsoft.Web.WebView2.Wpf.dll"
$loader = Join-Path $Root "package\runtimes\win-x64\native\WebView2Loader.dll"
if ((Test-Path $core) -and (Test-Path $wpf) -and (Test-Path $loader)) {
  exit 0
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
$package = Join-Path $Root "microsoft.web.webview2.$Version.nupkg"
$zip = Join-Path $Root "package.zip"
$extract = Join-Path $Root "package"
Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip -Force -ErrorAction SilentlyContinue

$uri = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg"
Invoke-WebRequest -Uri $uri -OutFile $package
Copy-Item $package $zip -Force
Expand-Archive -Path $zip -DestinationPath $extract -Force

if (-not ((Test-Path $core) -and (Test-Path $wpf) -and (Test-Path $loader))) {
  throw "WebView2 SDK package did not contain the expected WPF files."
}

[IO.File]::WriteAllText((Join-Path $Root "version.txt"), $Version, (New-Object Text.UTF8Encoding($false)))
exit 0
