[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Status", "ConfigureOpenAI", "InstallTailscale", "TailscaleLogin", "PrepareTailscale", "EnsureCloudflared", "CloudflareLogin", "ConfigureCloudflareNamed", "PrepareCloudflareQuick", "ResetLocalConnection")]
  [string]$Action,
  [int]$Port = 7317,
  [string]$InputPath = ""
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
  if ([string]::IsNullOrWhiteSpace($InputPath)) { return $null }
  if (-not (Test-Path -LiteralPath $InputPath)) { throw "Setup input file was not found." }
  try {
    $raw = [IO.File]::ReadAllText($InputPath, [Text.Encoding]::UTF8)
  } finally {
    Remove-Item -LiteralPath $InputPath -Force -ErrorAction SilentlyContinue
  }
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

function ConvertTo-DevRelayProcessArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Invoke-DevRelayStreamingExternal([string]$FilePath, [string[]]$Arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (($Arguments | ForEach-Object { ConvertTo-DevRelayProcessArgument ([string]$_) }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $stdoutText = New-Object Text.StringBuilder
  $stderrText = New-Object Text.StringBuilder
  try {
    [void]$process.Start()
    $stdoutBuffer = New-Object char[] 1024
    $stderrBuffer = New-Object char[] 1024
    $stdoutTask = $process.StandardOutput.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
    $stderrTask = $process.StandardError.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
    $stdoutDone = $false
    $stderrDone = $false

    while (-not $process.HasExited -or -not $stdoutDone -or -not $stderrDone) {
      if (-not $stdoutDone -and $stdoutTask.IsCompleted) {
        $count = $stdoutTask.Result
        if ($count -eq 0) {
          $stdoutDone = $true
        } else {
          $chunk = -join $stdoutBuffer[0..($count - 1)]
          [void]$stdoutText.Append($chunk)
          [Console]::Out.Write($chunk)
          [Console]::Out.Flush()
          $stdoutBuffer = New-Object char[] 1024
          $stdoutTask = $process.StandardOutput.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
        }
      }
      if (-not $stderrDone -and $stderrTask.IsCompleted) {
        $count = $stderrTask.Result
        if ($count -eq 0) {
          $stderrDone = $true
        } else {
          $chunk = -join $stderrBuffer[0..($count - 1)]
          [void]$stderrText.Append($chunk)
          [Console]::Out.Write($chunk)
          [Console]::Out.Flush()
          $stderrBuffer = New-Object char[] 1024
          $stderrTask = $process.StandardError.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
        }
      }
      if (-not $process.HasExited) { Start-Sleep -Milliseconds 50 }
      $process.Refresh()
    }

    $process.WaitForExit()
    $combined = $stdoutText.ToString() + [Environment]::NewLine + $stderrText.ToString()
    $output = @(($combined -split "`r?`n") | Where-Object { $_ -ne "" })
    return [pscustomobject]@{ Code = [int]$process.ExitCode; Output = $output }
  } finally {
    if (-not $process.HasExited) { try { $process.Kill() } catch {} }
    $process.Dispose()
  }
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

function Test-DevRelayPublicDnsRecord([string]$Hostname) {
  try {
    $labels = @($Hostname.Split(".") | Where-Object { $_ })
    $nameServer = $null
    for ($i = 1; $i -lt ($labels.Count - 1); $i++) {
      $zone = ($labels[$i..($labels.Count - 1)] -join ".")
      try {
        $ns = @(Resolve-DnsName -Name $zone -Type NS -DnsOnly -QuickTimeout -ErrorAction Stop | Where-Object { $_.NameHost } | Select-Object -ExpandProperty NameHost)
        if ($ns.Count -gt 0) { $nameServer = ([string]$ns[0]).TrimEnd("."); break }
      } catch {}
    }
    if (-not $nameServer) { return $false }
    $records = @(Resolve-DnsName -Name $Hostname -Server $nameServer -DnsOnly -QuickTimeout -ErrorAction Stop | Where-Object { $_.Type -in @("A", "AAAA", "CNAME") })
    return $records.Count -gt 0
  } catch { return $false }
}

try {
  switch ($Action) {
  "Status" {
    $tailscaleExe = Get-DevRelayTailscaleExe
    $tailscaleStatus = if ($tailscaleExe) { Get-TailscaleStatus $tailscaleExe } else { $null }
    Write-JsonResult ([ordered]@{
      openaiClientInstalled = Test-Path -LiteralPath $script:DevRelayOpenAITunnelExe
      cloudflaredInstalled = (Test-Path -LiteralPath $script:DevRelayCloudflaredExe) -or (Test-Path -LiteralPath $script:DevRelayLegacyCloudflaredExe)
      cloudflareLoggedIn = Test-Path -LiteralPath (Join-Path $HOME ".cloudflared\cert.pem")
      tailscaleInstalled = [bool]$tailscaleExe
      tailscaleLoggedIn = [bool](Get-TailscaleDnsName $tailscaleStatus)
      tailscaleDnsName = Get-TailscaleDnsName $tailscaleStatus
    })
    break
  }

  "ConfigureOpenAI" {
    $request = Read-InputJson
    $tunnelId = [string]$request.tunnelId
    $apiKey = [string]$request.apiKey
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
    $login = Invoke-DevRelayStreamingExternal $exe @("login", "--timeout=10m")
    if ($login.Code -ne 0) { throw "Tailscale sign-in did not complete. Use Sign in again and finish the browser approval." }
    $status = Get-TailscaleStatus $exe
    $dnsName = Get-TailscaleDnsName $status
    if (-not $dnsName) { throw "Tailscale sign-in finished but the device is not connected yet. Check the Tailscale client, then check status again." }
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
      $funnelResult = Invoke-DevRelayStreamingExternal $exe @("funnel", "--bg", "--yes", "--https=443", $target)
      if ($funnelResult.Code -ne 0) {
        throw "$exe funnel exited with code $($funnelResult.Code): $($funnelResult.Output -join ' ')"
      }

      $ready = $false
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $funnelStatus = Invoke-DevRelayExternal $exe @("funnel", "status", "--json") -AllowFailure
        if ($funnelStatus.Code -eq 0) {
          $joined = ($funnelStatus.Output -join [Environment]::NewLine).Trim()
          if ($joined -and $joined -ne "{}" -and $joined -ne "null") { $ready = $true; break }
        }
        Start-Sleep -Milliseconds 500
      }
      if (-not $ready) { throw "Tailscale Funnel command completed but no Funnel configuration became active." }
      Write-JsonResult ([ordered]@{
        ok = $true
        dnsName = $dnsName
        publicUrl = "https://$dnsName/mcp"
        funnelStatusAvailable = $true
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
    $certPath = Join-Path $HOME ".cloudflared\cert.pem"
    if (Test-Path -LiteralPath $certPath) {
      Write-JsonResult ([ordered]@{ ok = $true; alreadySignedIn = $true })
      break
    }
    $login = Invoke-DevRelayStreamingExternal $exe @("tunnel", "login")
    if ($login.Code -ne 0) { throw "Cloudflare sign-in did not complete. Use Sign in again and finish the browser approval." }
    if (-not (Test-Path -LiteralPath $certPath)) { throw "Cloudflare sign-in finished but cert.pem was not created. Check the browser result, then try Sign in again." }
    Write-JsonResult ([ordered]@{ ok = $true; alreadySignedIn = $false })
    break
  }

  "ConfigureCloudflareNamed" {
    $request = Read-InputJson
    $hostname = ([string]$request.hostname).Trim().ToLowerInvariant()
    $tunnelName = ([string]$request.tunnelName).Trim()
    if ($hostname -notmatch '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$' -or $hostname -notmatch '\.') { throw "Enter a valid full hostname such as devrelay.example.com." }
    if ([string]::IsNullOrWhiteSpace($tunnelName)) { $tunnelName = "devrelay" }
    $exe = Ensure-DevRelayCloudflared
    $certPath = Join-Path $HOME ".cloudflared\cert.pem"
    if (-not (Test-Path -LiteralPath $certPath)) { throw "Sign in to Cloudflare before using this hostname." }
    if (Test-DevRelayPublicDnsRecord $hostname) {
      throw "The hostname $hostname already has a public DNS record. Remove its existing A, AAAA, or CNAME record in Cloudflare DNS, or use another hostname. DevRelay will not overwrite existing DNS records."
    }

    $list = Invoke-DevRelayExternal $exe @("tunnel", "list", "--output", "json")
    $tunnels = @()
    try { $tunnels = @(($list.Output -join [Environment]::NewLine) | ConvertFrom-Json) } catch {}
    $existing = $tunnels | Where-Object { [string]$_.name -eq $tunnelName } | Select-Object -First 1
    $tunnelId = if ($existing) { [string]$existing.id } else { "" }
    if (-not $tunnelId) {
      $created = Invoke-DevRelayExternal $exe @("tunnel", "create", $tunnelName)
      $joined = $created.Output -join [Environment]::NewLine
      $match = [regex]::Match($joined, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
      if (-not $match.Success) { throw "Cloudflare connection was created but its ID could not be determined." }
      $tunnelId = $match.Value
    }

    $route = Invoke-DevRelayExternal $exe @("tunnel", "route", "dns", $tunnelId, $hostname) -AllowFailure
    if ($route.Code -ne 0) {
      $routeText = $route.Output -join " "
      if ($routeText -match 'code:\s*1003' -or $routeText -match 'already exists') {
        throw "The hostname $hostname already has a DNS record in Cloudflare. Remove its existing A, AAAA, or CNAME record, or use another hostname. DevRelay will not overwrite existing DNS records."
      }
      throw "Cloudflare could not create the DNS route: $routeText"
    }

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
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
