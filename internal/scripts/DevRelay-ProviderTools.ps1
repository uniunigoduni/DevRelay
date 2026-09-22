Set-StrictMode -Version Latest

$script:DevRelayInternalRoot = Split-Path -Parent $PSScriptRoot
$script:DevRelayStateDir = Join-Path $script:DevRelayInternalRoot ".devrelay"
$script:DevRelayLegacyTunnelToolDir = Join-Path $script:DevRelayInternalRoot "tools\tunnel-client"
$script:DevRelayOpenAITunnelExe = Join-Path $script:DevRelayLegacyTunnelToolDir "tunnel-client.exe"
$script:DevRelayLegacyCloudflaredExe = Join-Path $script:DevRelayLegacyTunnelToolDir "cloudflared.exe"
$script:DevRelayCloudflaredDir = Join-Path $script:DevRelayStateDir "tools\cloudflared"
$script:DevRelayCloudflaredExe = Join-Path $script:DevRelayCloudflaredDir "cloudflared.exe"

function Ensure-DevRelayDirectory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
}

function Get-DevRelayWindowsArchitecture {
  $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($arch -eq "arm64") { return "arm64" }
  if ($arch -eq "x64") { return "amd64" }
  throw "Unsupported Windows architecture: $arch"
}

function Invoke-DevRelayExternal([string]$FilePath, [string[]]$Arguments, [switch]$AllowFailure) {
  $previousPreference = $ErrorActionPreference
  try {
    # Native CLIs often write progress or browser-login instructions to stderr.
    # Windows PowerShell can promote that stderr to an ErrorRecord when the
    # caller uses ErrorActionPreference=Stop, even when the process exits 0.
    $ErrorActionPreference = "Continue"
    $output = & $FilePath @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "$FilePath $($Arguments -join ' ') exited with code ${code}: $($output -join ' ')"
  }
  return [pscustomobject]@{ Code = $code; Output = @($output | ForEach-Object { [string]$_ }) }
}

function ConvertFrom-DevRelayJsonArrayOutput($Output) {
  $text = @($Output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  $start = $text.IndexOf("[")
  $end = $text.LastIndexOf("]")
  if ($start -lt 0 -or $end -lt $start) { throw "External command did not return a JSON array." }
  $json = $text.Substring($start, $end - $start + 1)
  try { return @($json | ConvertFrom-Json) }
  catch { throw "External command returned an invalid JSON array: $($_.Exception.Message)" }
}

function Ensure-DevRelayOpenAITunnelClient {
  if (Test-Path -LiteralPath $script:DevRelayOpenAITunnelExe) { return $script:DevRelayOpenAITunnelExe }

  Ensure-DevRelayDirectory $script:DevRelayLegacyTunnelToolDir
  $arch = Get-DevRelayWindowsArchitecture
  $headers = @{ "User-Agent" = "DevRelay-Setup" }
  $release = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "https://api.github.com/repos/openai/tunnel-client/releases/latest"
  $pattern = "^tunnel-client-v[0-9].*-windows-$arch\.zip$"
  $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) { throw "No official OpenAI tunnel-client Windows asset matched $pattern" }

  $tempRoot = Join-Path $env:TEMP ("devrelay-openai-tunnel-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempRoot $asset.name
  $extractDir = Join-Path $tempRoot "extract"
  Ensure-DevRelayDirectory $tempRoot
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zipPath
    if ($asset.digest -and ([string]$asset.digest).StartsWith("sha256:")) {
      $expected = ([string]$asset.digest).Substring(7).ToUpperInvariant()
      $actual = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToUpperInvariant()
      if ($actual -ne $expected) { throw "OpenAI tunnel-client archive checksum mismatch." }
    }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    $candidate = Get-ChildItem $extractDir -Recurse -Filter "tunnel-client.exe" | Select-Object -First 1
    if (-not $candidate) { throw "Downloaded OpenAI tunnel-client archive did not contain tunnel-client.exe" }
    Get-ChildItem $script:DevRelayLegacyTunnelToolDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Copy-Item (Join-Path $candidate.DirectoryName "*") $script:DevRelayLegacyTunnelToolDir -Recurse -Force
  } finally {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  return $script:DevRelayOpenAITunnelExe
}

function Ensure-DevRelayCloudflared {
  if (Test-Path -LiteralPath $script:DevRelayCloudflaredExe) { return $script:DevRelayCloudflaredExe }
  if (Test-Path -LiteralPath $script:DevRelayLegacyCloudflaredExe) { return $script:DevRelayLegacyCloudflaredExe }

  Ensure-DevRelayDirectory $script:DevRelayCloudflaredDir
  $arch = Get-DevRelayWindowsArchitecture
  $headers = @{ "User-Agent" = "DevRelay-Setup" }
  $release = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
  $assetName = "cloudflared-windows-$arch.exe"
  $asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
  if (-not $asset) { throw "No official cloudflared Windows asset named $assetName was found." }
  $tempPath = Join-Path $script:DevRelayCloudflaredDir ($assetName + ".download")
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $tempPath
    if ($asset.digest -and ([string]$asset.digest).StartsWith("sha256:")) {
      $expected = ([string]$asset.digest).Substring(7).ToUpperInvariant()
      $actual = (Get-FileHash -Algorithm SHA256 -Path $tempPath).Hash.ToUpperInvariant()
      if ($actual -ne $expected) { throw "cloudflared executable checksum mismatch." }
    }
    Move-Item -LiteralPath $tempPath -Destination $script:DevRelayCloudflaredExe -Force
  } finally {
    Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
  }
  return $script:DevRelayCloudflaredExe
}

function Get-DevRelayTailscaleExe {
  $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "Tailscale\tailscale.exe" } else { $null })
  ) | Where-Object { $_ }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

function Install-DevRelayTailscale {
  $existing = Get-DevRelayTailscaleExe
  if ($existing) { return $existing }

  $packagePage = Invoke-WebRequest -UseBasicParsing -Uri "https://pkgs.tailscale.com/stable/"
  $matches = [regex]::Matches([string]$packagePage.Content, 'tailscale-setup-([0-9]+\.[0-9]+\.[0-9]+)\.exe')
  if ($matches.Count -eq 0) { throw "Could not find the current official Tailscale Windows installer." }
  $versions = @()
  foreach ($match in $matches) {
    try { $versions += [pscustomobject]@{ Version = [version]$match.Groups[1].Value; Name = $match.Value } } catch {}
  }
  $latest = $versions | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $latest) { throw "Could not determine the latest official Tailscale Windows installer." }

  $installerUrl = "https://pkgs.tailscale.com/stable/$($latest.Name)"
  $shaUrl = "$installerUrl.sha256"
  $tempDir = Join-Path $env:TEMP ("devrelay-tailscale-" + [guid]::NewGuid().ToString("N"))
  $installerPath = Join-Path $tempDir $latest.Name
  Ensure-DevRelayDirectory $tempDir
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -OutFile $installerPath
    try {
      $shaText = (Invoke-WebRequest -UseBasicParsing -Uri $shaUrl).Content
      $expected = ([regex]::Match([string]$shaText, '[0-9a-fA-F]{64}')).Value.ToUpperInvariant()
      if ($expected) {
        $actual = (Get-FileHash -Algorithm SHA256 -Path $installerPath).Hash.ToUpperInvariant()
        if ($actual -ne $expected) { throw "Tailscale installer checksum mismatch." }
      }
    } catch {
      if ($_.Exception.Message -like "*checksum mismatch*") { throw }
    }
    $signature = Get-AuthenticodeSignature -FilePath $installerPath
    if ([string]$signature.Status -ne "Valid") {
      throw "Tailscale installer Authenticode signature is not valid: $($signature.Status)."
    }
    $process = Start-Process -FilePath $installerPath -Verb RunAs -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Tailscale installer exited with code $($process.ExitCode)." }
  } finally {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  for ($i = 0; $i -lt 20; $i++) {
    $installed = Get-DevRelayTailscaleExe
    if ($installed) { return $installed }
    Start-Sleep -Milliseconds 500
  }
  throw "Tailscale was installed but tailscale.exe could not be located."
}

function Save-DevRelayDpapiSecret([string]$Path, [string]$PlainText) {
  Ensure-DevRelayDirectory (Split-Path -Parent $Path)
  $secure = ConvertTo-SecureString -String $PlainText -AsPlainText -Force
  $encrypted = $secure | ConvertFrom-SecureString
  [IO.File]::WriteAllText($Path, $encrypted + [Environment]::NewLine, [Text.Encoding]::UTF8)
}

function Read-DevRelayDpapiSecret([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $encrypted = (Get-Content -Raw -LiteralPath $Path).Trim()
    if (-not $encrypted) { return $null }
    $secure = ConvertTo-SecureString $encrypted
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  } catch { return $null }
}
