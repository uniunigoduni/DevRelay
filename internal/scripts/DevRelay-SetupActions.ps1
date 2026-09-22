[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Status", "ConfigureOpenAI", "InstallTailscale", "TailscaleLogin", "PrepareTailscale", "EnsureCloudflared", "CloudflareLogin", "ConfigureCloudflareNamed", "PrepareCloudflareQuick", "ResetLocalConnection")]
  [string]$Action,
  [int]$Port = 7317
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "DevRelay-ProviderTools.ps1")

$StateDir = $script:DevRelayStateDir
$LauncherPath = Join-Path $StateDir "launcher.json"
$SecretPath = Join-Path $StateDir "control-plane-api-key.dpapi"
$ProfileDir = Join-Path $StateDir "tunnel-profiles"
$CloudflareDir = Join-Path $StateDir "cloudflare"
$CloudflareNamedPath = Join-Path $StateDir "cloudflare-named.json"
$LegacyNamedPath = Join-Path $StateDir "https-named.json"

function Read-InputJson {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json
}

function Write-JsonResult($Value) {
  $Value | ConvertTo-Json -Depth 8 -Compress | Write-Output
}

function Write-StateJson([string]$Path, $Value) {
  Ensure-DevRelayDirectory (Split-Path -Parent $Path)
  $json = $Value | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [Text.Encoding]::UTF8)
}

function Get-TailscaleStatus([string]$Exe) {
  $result = Invoke-DevRelayExternal $Exe @("status", "--json") -AllowFailure
  if ($result.Code -ne 0) { return $null }
  try { return (($result.Output -join [Environment]::NewLine) | ConvertFrom-Json) } catch { return $null }
}

function Get-TailscaleDnsName($Status) {
  if ($null -eq $Status) { return $null }
  $dns = [string]$Status.Self.DNSName
  if (-not $dns) { return $null }
  return $dns.TrimEnd(".")
}

switch ($Action) {
  "Status" {
    $tailscaleExe = Get-DevRelayTailscaleExe
    $tailscaleStatus = if ($tailscaleExe) { Get-TailscaleStatus $tailscaleExe } else { $null }
    Write-JsonResult ([ordered]@{
      openaiClientInstalled = Test-Path -LiteralPath $script:DevRelayOpenAITunnelExe
      cloudflaredInstalled = (Test-Path -LiteralPath $script:DevRelayCloudflaredExe) -or (Test-Path -LiteralPath $script:DevRelayLegacyCloudflaredExe)
      tailscaleInstalled = [bool]$tailscaleExe
      tailscaleLoggedIn = [bool](Get-TailscaleDnsName $tailscaleStatus)
      tailscaleDnsName = Get-TailscaleDnsName $tailscaleStatus
    })
    break
  }

  "ConfigureOpenAI" {
    $input = Read-InputJson
    $tunnelId = [string]$input.tunnelId
    $apiKey = [string]$input.apiKey
    if ($tunnelId -notmatch '^tunnel_[a-z0-9]{32}$') { throw "Tunnel ID must be tunnel_ followed by 32 lowercase letters or digits." }
    if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "Runtime API key is required." }

    $exe = Ensure-DevRelayOpenAITunnelClient
    Write-StateJson $LauncherPath ([ordered]@{ profile = "devrelay"; tunnelId = $tunnelId; mcpUrl = "http://127.0.0.1:$Port/mcp" })
    Save-DevRelayDpapiSecret $SecretPath $apiKey
    Ensure-DevRelayDirectory $ProfileDir
    $previous = $env:CONTROL_PLANE_API_KEY
    try {
      $env:CONTROL_PLANE_API_KEY = $apiKey
      Invoke-DevRelayExternal $exe @("init", "--sample", "sample_mcp_remote_no_auth", "--profile", "devrelay", "--profile-dir", $ProfileDir, "--tunnel-id", $tunnelId, "--mcp-server-url", "http://127.0.0.1:$Port/mcp", "--health-listen-addr", "127.0.0.1:0", "--force") | Out-Null
    } finally {
      $env:CONTROL_PLANE_API_KEY = $previous
      $apiKey = $null
    }
    Write-JsonResult ([ordered]@{ ok = $true; tunnelId = $tunnelId })
    break
  }

  "InstallTailscale" {
    $exe = Install-DevRelayTailscale
    Write-JsonResult ([ordered]@{ ok = $true; executable = $exe })
    break
  }

  "TailscaleLogin" {
    $exe = Get-DevRelayTailscaleExe
    if (-not $exe) { throw "Tailscale is not installed." }
    Invoke-DevRelayExternal $exe @("login") | Out-Null
    $status = Get-TailscaleStatus $exe
    $dnsName = Get-TailscaleDnsName $status
    if (-not $dnsName) { throw "Tailscale login completed but no tailnet DNS name is available." }
    Write-JsonResult ([ordered]@{ ok = $true; dnsName = $dnsName; publicUrl = "https://$dnsName/mcp" })
    break
  }

  "PrepareTailscale" {
    $exe = Get-DevRelayTailscaleExe
    if (-not $exe) { throw "Tailscale is not installed." }
    $status = Get-TailscaleStatus $exe
    $dnsName = Get-TailscaleDnsName $status
    if (-not $dnsName) { throw "Sign in to Tailscale before enabling Funnel." }
    $target = "127.0.0.1:$Port"
    try {
      Invoke-DevRelayExternal $exe @("funnel", "--bg", "--yes", "--https=443", $target) | Out-Null
      $funnelStatus = Invoke-DevRelayExternal $exe @("funnel", "status", "--json") -AllowFailure
      Write-JsonResult ([ordered]@{
        ok = $true
        dnsName = $dnsName
        publicUrl = "https://$dnsName/mcp"
        funnelStatusAvailable = $funnelStatus.Code -eq 0
      })
    } finally {
      Invoke-DevRelayExternal $exe @("funnel", "reset") -AllowFailure | Out-Null
    }
    break
  }

  "EnsureCloudflared" {
    $exe = Ensure-DevRelayCloudflared
    Write-JsonResult ([ordered]@{ ok = $true; executable = $exe })
    break
  }

  "CloudflareLogin" {
    $exe = Ensure-DevRelayCloudflared
    Invoke-DevRelayExternal $exe @("tunnel", "login") | Out-Null
    $certPath = Join-Path $HOME ".cloudflared\cert.pem"
    if (-not (Test-Path -LiteralPath $certPath)) { throw "Cloudflare login completed but cert.pem was not found." }
    Write-JsonResult ([ordered]@{ ok = $true })
    break
  }

  "ConfigureCloudflareNamed" {
    $input = Read-InputJson
    $hostname = ([string]$input.hostname).Trim().ToLowerInvariant()
    $tunnelName = ([string]$input.tunnelName).Trim()
    if ($hostname -notmatch '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$' -or $hostname -notmatch '\.') { throw "Enter a valid full hostname such as devrelay.example.com." }
    if ([string]::IsNullOrWhiteSpace($tunnelName)) { $tunnelName = "devrelay" }
    $exe = Ensure-DevRelayCloudflared
    $certPath = Join-Path $HOME ".cloudflared\cert.pem"
    if (-not (Test-Path -LiteralPath $certPath)) { throw "Sign in to Cloudflare before creating a Named Tunnel." }

    $list = Invoke-DevRelayExternal $exe @("tunnel", "list", "--output", "json")
    $tunnels = @()
    try { $tunnels = @(($list.Output -join [Environment]::NewLine) | ConvertFrom-Json) } catch {}
    $existing = $tunnels | Where-Object { [string]$_.name -eq $tunnelName } | Select-Object -First 1
    $tunnelId = if ($existing) { [string]$existing.id } else { "" }
    if (-not $tunnelId) {
      $created = Invoke-DevRelayExternal $exe @("tunnel", "create", $tunnelName)
      $joined = $created.Output -join [Environment]::NewLine
      $match = [regex]::Match($joined, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
      if (-not $match.Success) { throw "Cloudflare created the tunnel but its ID could not be determined." }
      $tunnelId = $match.Value
    }

    Invoke-DevRelayExternal $exe @("tunnel", "route", "dns", $tunnelId, $hostname) | Out-Null

    $sourceCredentials = Join-Path $HOME ".cloudflared\$tunnelId.json"
    if (-not (Test-Path -LiteralPath $sourceCredentials)) { throw "Cloudflare tunnel credentials were not found at $sourceCredentials" }
    Ensure-DevRelayDirectory $CloudflareDir
    $credentials = Join-Path $CloudflareDir "$tunnelId.json"
    Copy-Item -LiteralPath $sourceCredentials -Destination $credentials -Force
    $configPath = Join-Path $CloudflareDir "config.yml"
    $yamlCredentials = $credentials.Replace("\", "/")
    $yaml = @"
tunnel: $tunnelId
credentials-file: $yamlCredentials
ingress:
  - hostname: $hostname
    service: http://127.0.0.1:$Port
    originRequest:
      httpHostHeader: localhost
  - service: http_status:404
"@
    [IO.File]::WriteAllText($configPath, $yaml, (New-Object Text.UTF8Encoding($false)))
    $value = [ordered]@{ tunnelId = $tunnelId; tunnelName = $tunnelName; hostname = $hostname; configPath = $configPath; credentialsPath = $credentials }
    Write-StateJson $CloudflareNamedPath $value
    Write-StateJson $LegacyNamedPath $value
    Write-JsonResult ([ordered]@{ ok = $true; publicUrl = "https://$hostname/mcp"; tunnelId = $tunnelId; tunnelName = $tunnelName })
    break
  }

  "PrepareCloudflareQuick" {
    [void](Ensure-DevRelayCloudflared)
    Write-JsonResult ([ordered]@{ ok = $true; persistent = $false })
    break
  }

  "ResetLocalConnection" {
    Remove-Item $LauncherPath -Force -ErrorAction SilentlyContinue
    Remove-Item $SecretPath -Force -ErrorAction SilentlyContinue
    Remove-Item $ProfileDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $CloudflareNamedPath -Force -ErrorAction SilentlyContinue
    Remove-Item $LegacyNamedPath -Force -ErrorAction SilentlyContinue
    Remove-Item $CloudflareDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-JsonResult ([ordered]@{ ok = $true })
    break
  }
}
