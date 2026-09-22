[CmdletBinding()]
param(
  [switch]$SetupOnly,
  [switch]$NoTunnel,
  [switch]$ForceSetup,
  [switch]$ResetTunnel,
  [switch]$Status,
  [string]$Profile = "devrelay",
  [int]$Port = 7317
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Root ".devrelay"
$StatePath = Join-Path $StateDir "launcher-state.json"
$SetupPath = Join-Path $StateDir "setup.json"
$OpenAIConfigPath = Join-Path $StateDir "launcher.json"
$SecretPath = Join-Path $StateDir "control-plane-api-key.dpapi"
$ProfileDir = Join-Path $StateDir "tunnel-profiles"
$CloudflareNamedPath = Join-Path $StateDir "cloudflare-named.json"
$LegacyNamedPath = Join-Path $StateDir "https-named.json"
$HostAddress = "127.0.0.1"
$McpUrl = "http://${HostAddress}:$Port/mcp"

. (Join-Path $PSScriptRoot "DevRelay-ProviderTools.ps1")

function Write-Step([string]$Message) {
  Write-Host "[DevRelay] $Message" -ForegroundColor Cyan
}
function Ensure-Directory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}
function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $raw = Get-Content -Raw -LiteralPath $Path
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json
}
function Write-JsonFile([string]$Path, $Value) {
  Ensure-Directory (Split-Path -Parent $Path)
  $json = $Value | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}
function Get-ObjectValue($Object, [string]$Name, $Default = $null) {
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}
function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $Root) {
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$FilePath exited with code $LASTEXITCODE" }
  } finally { Pop-Location }
}
function Get-LockHash {
  $lockPath = Join-Path $Root "package-lock.json"
  if (-not (Test-Path $lockPath)) { return "missing" }
  return (Get-FileHash -Algorithm SHA256 -Path $lockPath).Hash
}
function Build-Is-Stale {
  $entry = Join-Path $Root "dist\src\main.js"
  if (-not (Test-Path $entry)) { return $true }
  $builtAt = (Get-Item $entry).LastWriteTimeUtc
  $inputs = @((Join-Path $Root "package.json"), (Join-Path $Root "tsconfig.json"))
  $inputs += Get-ChildItem (Join-Path $Root "src") -Filter *.ts -Recurse | Select-Object -ExpandProperty FullName
  foreach ($input in $inputs) { if ((Get-Item $input).LastWriteTimeUtc -gt $builtAt) { return $true } }
  return $false
}
function Ensure-Build {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $node -or -not $npm) { throw "Node.js 20+ and npm are required. Install Node.js, then rerun DevRelay.exe." }

  $state = Read-JsonFile $StatePath
  $lockHash = Get-LockHash
  $installedHash = [string](Get-ObjectValue $state "packageLockHash" "")
  $nodeModules = Join-Path $Root "node_modules"
  if ($ForceSetup -or -not (Test-Path $nodeModules) -or $installedHash -ne $lockHash) {
    Write-Step "Installing npm dependencies..."
    Invoke-Checked $npm.Source @("ci")
  } else { Write-Step "npm dependencies are already installed." }

  if ($ForceSetup -or (Build-Is-Stale)) {
    Write-Step "Building DevRelay..."
    Invoke-Checked $npm.Source @("run", "build")
  } else { Write-Step "Build is already current." }

  Write-JsonFile $StatePath ([ordered]@{ packageLockHash = $lockHash; lastPreparedAt = (Get-Date).ToUniversalTime().ToString("o") })
  return $node.Source
}
function Test-LocalPort([int]$TestPort, [int]$TimeoutMs = 500) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($HostAddress, $TestPort, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($async)
    return $client.Connected
  } catch { return $false }
  finally { $client.Close() }
}
function Stop-ProcessTree($Process) {
  if ($null -eq $Process) { return }
  try {
    if (-not $Process.HasExited) { & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null }
  } catch { try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch {} }
}
function Start-DevRelay([string]$NodeExe) {
  if (Test-LocalPort $Port) { throw "TCP port $Port is already in use. Stop the existing listener or change the Port setting." }
  $entry = Join-Path $Root "dist\src\main.js"
  Write-Step "Starting DevRelay HTTP MCP at $McpUrl..."
  $process = Start-Process -FilePath $NodeExe -ArgumentList @($entry, "--http", "--host", $HostAddress, "--port", [string]$Port) -WorkingDirectory $Root -NoNewWindow -PassThru
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { throw "DevRelay exited during startup with code $($process.ExitCode)." }
    if (Test-LocalPort $Port) { Write-Step "DevRelay is ready."; return $process }
  }
  Stop-ProcessTree $process
  throw "DevRelay did not become ready on $McpUrl."
}
function Set-HttpsOAuth([string]$PublicMcpUrl) {
  if ($PublicMcpUrl -notmatch '^https://') { throw "HTTPS connection did not provide a valid public MCP URL." }
  $uri = [Uri]$PublicMcpUrl
  $env:DEVRELAY_OAUTH_ISSUER = $uri.GetLeftPart([UriPartial]::Authority)
  $env:DEVRELAY_OAUTH_RESOURCE = $PublicMcpUrl
}
function Clear-HttpsOAuth {
  Remove-Item Env:DEVRELAY_OAUTH_ISSUER -ErrorAction SilentlyContinue
  Remove-Item Env:DEVRELAY_OAUTH_RESOURCE -ErrorAction SilentlyContinue
}
function Require-Setup {
  $setup = Read-JsonFile $SetupPath
  if ($null -eq $setup -or -not [bool](Get-ObjectValue $setup "completed" $false) -or $null -eq $setup.connection) {
    throw "DevRelay connection setup is incomplete. Run DevRelay.exe and complete Connection Setup."
  }
  return $setup
}
function Get-ConnectionDescription($Connection) {
  if ([string]$Connection.kind -eq "openai-secure-tunnel") { return "OpenAI Secure Tunnel" }
  if ([string]$Connection.provider -eq "tailscale") { return "HTTPS / Tailscale Funnel" }
  if ([string]$Connection.provider -eq "cloudflare" -and [string]$Connection.variant -eq "quick") { return "HTTPS / Cloudflare temporary URL" }
  if ([string]$Connection.provider -eq "cloudflare" -and [string]$Connection.variant -eq "named") { return "HTTPS / Cloudflare custom hostname" }
  return "Unknown"
}
function Get-TailscalePublicUrl([string]$Exe) {
  $result = Invoke-DevRelayExternal $Exe @("status", "--json") -AllowFailure
  if ($result.Code -ne 0) { throw "Tailscale is not signed in." }
  $status = ($result.Output -join [Environment]::NewLine) | ConvertFrom-Json
  $dnsName = [string]$status.Self.DNSName
  if (-not $dnsName) { throw "Tailscale did not report a tailnet DNS name." }
  $dnsName = $dnsName.TrimEnd(".")
  return "https://$dnsName/mcp"
}
function Start-TailscaleFunnel([string]$Exe) {
  Write-Step "Starting Tailscale Funnel..."
  return Start-Process -FilePath $Exe -ArgumentList @("funnel", "--yes", "--https=443", "127.0.0.1:$Port") -WorkingDirectory $Root -NoNewWindow -PassThru
}
function Get-CloudflareNamedSettings {
  $settings = Read-JsonFile $CloudflareNamedPath
  if ($null -eq $settings) { $settings = Read-JsonFile $LegacyNamedPath }
  if ($null -eq $settings) { throw "Cloudflare custom hostname setup is incomplete. Reopen Connection Setup." }
  if (-not [string]$settings.tunnelName -or -not [string]$settings.hostname -or -not [string]$settings.configPath) { throw "Cloudflare custom hostname settings are incomplete." }
  if (-not (Test-Path -LiteralPath ([string]$settings.configPath))) { throw "Cloudflare custom hostname config file is missing. Reopen Connection Setup." }
  return $settings
}
function Get-CloudflareNamedRuntimeSettings($Settings) {
  $sourceConfig = [string]$Settings.configPath
  $sourceText = Get-Content -Raw -LiteralPath $sourceConfig
  $tunnelId = [string](Get-ObjectValue $Settings "tunnelId" "")
  if (-not $tunnelId) {
    $match = [regex]::Match($sourceText, '(?m)^\s*tunnel:\s*([^#\r\n]+)')
    if ($match.Success) { $tunnelId = $match.Groups[1].Value.Trim().Trim('"').Trim("'") }
  }
  $credentialsPath = [string](Get-ObjectValue $Settings "credentialsPath" "")
  if (-not $credentialsPath) {
    $match = [regex]::Match($sourceText, '(?m)^\s*credentials-file:\s*([^#\r\n]+)')
    if ($match.Success) { $credentialsPath = $match.Groups[1].Value.Trim().Trim('"').Trim("'") }
  }
  if (-not $tunnelId -or -not $credentialsPath) { throw "Cloudflare custom hostname config is missing tunnel/credentials information. Reopen Connection Setup." }
  if (-not [IO.Path]::IsPathRooted($credentialsPath)) { $credentialsPath = Join-Path (Split-Path -Parent $sourceConfig) $credentialsPath }
  if (-not (Test-Path -LiteralPath $credentialsPath)) { throw "Cloudflare custom hostname credentials file is missing. Reopen Connection Setup." }

  $runtimeDir = Join-Path $StateDir "cloudflare-runtime"
  Ensure-Directory $runtimeDir
  $runtimeConfig = Join-Path $runtimeDir "config.yml"
  $yamlCredentials = $credentialsPath.Replace("\", "/")
  $hostname = [string]$Settings.hostname
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
  [IO.File]::WriteAllText($runtimeConfig, $yaml, (New-Object Text.UTF8Encoding($false)))
  return [pscustomobject]@{ tunnelName = [string]$Settings.tunnelName; hostname = $hostname; configPath = $runtimeConfig }
}

function Start-CloudflareNamed([string]$Exe, $Settings) {
  $logRoot = if ($env:DEVRELAY_SESSION_DIR) { $env:DEVRELAY_SESSION_DIR } else { $StateDir }
  Ensure-Directory $logRoot
  $logPath = Join-Path $logRoot "cloudflared-named.log"
  Remove-Item $logPath -Force -ErrorAction SilentlyContinue
  $arguments = @("tunnel", "--config", [string]$Settings.configPath, "--loglevel", "info", "--logfile", $logPath, "run", [string]$Settings.tunnelName)
  $process = Start-Process -FilePath $Exe -ArgumentList $arguments -WorkingDirectory $Root -NoNewWindow -PassThru
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) {
      $details = if (Test-Path $logPath) { Get-Content -Raw $logPath } else { "" }
      throw "cloudflared exited during startup with code $($process.ExitCode). $details"
    }
    if ((Test-Path $logPath) -and ((Get-Content -Raw $logPath) -match 'Registered tunnel connection')) { return $process }
  }
  Stop-ProcessTree $process
  throw "Cloudflare custom hostname did not become ready within 20 seconds."
}
function Start-CloudflareQuick([string]$Exe) {
  $logRoot = if ($env:DEVRELAY_SESSION_DIR) { $env:DEVRELAY_SESSION_DIR } else { $StateDir }
  Ensure-Directory $logRoot
  $logPath = Join-Path $logRoot "cloudflared-quick.log"
  $stdoutPath = Join-Path $logRoot "cloudflared-quick.stdout.log"
  $stderrPath = Join-Path $logRoot "cloudflared-quick.stderr.log"
  Remove-Item $logPath,$stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue
  Write-Step "Creating Cloudflare temporary URL..."
  $process = Start-Process -FilePath $Exe -ArgumentList @("tunnel", "--url", "http://${HostAddress}:$Port", "--loglevel", "info", "--logfile", $logPath) -WorkingDirectory $Root -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { throw "cloudflared temporary URL exited during startup with code $($process.ExitCode)." }
    $text = ""
    foreach ($path in @($logPath,$stdoutPath,$stderrPath)) { if (Test-Path $path) { $text += "`n" + (Get-Content -Raw $path) } }
    $match = [regex]::Match($text, 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
    if ($match.Success) { return [pscustomobject]@{ Process = $process; PublicMcpUrl = ($match.Value.TrimEnd('/') + "/mcp") } }
  }
  Stop-ProcessTree $process
  throw "Cloudflare temporary URL did not provide a public URL within 20 seconds."
}
function Ensure-OpenAIProfile([string]$Exe, $Config, [string]$ApiKey) {
  $tunnelId = [string](Get-ObjectValue $Config "tunnelId" "")
  if ($tunnelId -notmatch '^tunnel_[a-z0-9]{32}$') { throw "Saved OpenAI tunnel ID is invalid. Reopen Connection Setup." }
  Ensure-Directory $ProfileDir
  $previous = $env:CONTROL_PLANE_API_KEY
  try {
    $env:CONTROL_PLANE_API_KEY = $ApiKey
    Invoke-DevRelayExternal $Exe @("init", "--sample", "sample_mcp_remote_no_auth", "--profile", $Profile, "--profile-dir", $ProfileDir, "--tunnel-id", $tunnelId, "--mcp-server-url", $McpUrl, "--health-listen-addr", "127.0.0.1:0", "--force") | Out-Null
  } finally { $env:CONTROL_PLANE_API_KEY = $previous }
}
function Invoke-OpenAIDoctor([string]$Exe, [string]$ApiKey) {
  $previous = $env:CONTROL_PLANE_API_KEY
  try {
    $env:CONTROL_PLANE_API_KEY = $ApiKey
    Invoke-DevRelayExternal $Exe @("doctor", "--profile", $Profile, "--profile-dir", $ProfileDir, "--explain") | Out-Null
  } finally { $env:CONTROL_PLANE_API_KEY = $previous }
}
function Show-LauncherStatus {
  $setup = Read-JsonFile $SetupPath
  Write-Host "DevRelay launcher status" -ForegroundColor Cyan
  Write-Host "  Connection:   $(if ($setup -and $setup.connection) { Get-ConnectionDescription $setup.connection } else { 'not configured' })"
  Write-Host "  MCP endpoint: $McpUrl"
  Write-Host "  MCP listener: $(if (Test-LocalPort $Port) { 'listening' } else { 'stopped' })"
  Write-Host "  Build:        $(if (Build-Is-Stale) { 'missing/stale' } else { 'current' })"
}

Ensure-Directory $StateDir
if ($ResetTunnel) {
  Write-Step "Resetting local DevRelay connection settings..."
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "DevRelay-SetupActions.ps1") -Action ResetLocalConnection -Port $Port | Out-Null
  Remove-Item $SetupPath -Force -ErrorAction SilentlyContinue
}
if ($Status) { Show-LauncherStatus; exit 0 }

$nodeExe = Ensure-Build

# The release updater uses this path. It must never require provider setup.
if ($SetupOnly -and $NoTunnel) {
  Write-Step "Local DevRelay build/setup is complete. Connection setup was skipped."
  exit 0
}

if ($NoTunnel) {
  if ($SetupOnly) { Write-Step "Local DevRelay build/setup is complete."; exit 0 }
  Clear-HttpsOAuth
  $devRelayProcess = $null
  try {
    $devRelayProcess = Start-DevRelay $nodeExe
    Write-Host "DevRelay is running locally at $McpUrl" -ForegroundColor Green
    while (-not $devRelayProcess.HasExited) { Start-Sleep -Seconds 1 }
    throw "DevRelay exited with code $($devRelayProcess.ExitCode)."
  } finally { Stop-ProcessTree $devRelayProcess }
}

$setup = Require-Setup
$connection = $setup.connection
$description = Get-ConnectionDescription $connection
Write-Step "Using $description."

if ([string]$connection.kind -eq "openai-secure-tunnel") {
  Clear-HttpsOAuth
  $config = Read-JsonFile $OpenAIConfigPath
  $apiKey = Read-DevRelayDpapiSecret $SecretPath
  if ($null -eq $config -or [string]::IsNullOrWhiteSpace($apiKey)) { throw "OpenAI Secure Tunnel credentials are incomplete. Reopen Connection Setup." }
  $tunnelExe = Ensure-DevRelayOpenAITunnelClient
  Ensure-OpenAIProfile $tunnelExe $config $apiKey
  if ($SetupOnly) { Write-Step "OpenAI Secure Tunnel setup is ready."; exit 0 }

  $devRelayProcess = $null
  $tunnelProcess = $null
  $previousApiKey = $env:CONTROL_PLANE_API_KEY
  try {
    $devRelayProcess = Start-DevRelay $nodeExe
    Invoke-OpenAIDoctor $tunnelExe $apiKey
    $env:CONTROL_PLANE_API_KEY = $apiKey
    $tunnelProcess = Start-Process -FilePath $tunnelExe -ArgumentList @("run", "--profile", $Profile, "--profile-dir", $ProfileDir) -WorkingDirectory $Root -NoNewWindow -PassThru
    Start-Sleep -Seconds 1
    if ($tunnelProcess.HasExited) { throw "OpenAI tunnel-client exited during startup with code $($tunnelProcess.ExitCode)." }
    Write-Host "DevRelay is online for ChatGPT." -ForegroundColor Green
    Write-Host "  Local MCP: $McpUrl"
    Write-Host "  Tunnel ID: $([string]$config.tunnelId)"
    while ($true) {
      Start-Sleep -Seconds 1
      if ($devRelayProcess.HasExited) { throw "DevRelay exited with code $($devRelayProcess.ExitCode)." }
      if ($tunnelProcess.HasExited) { throw "OpenAI tunnel-client exited with code $($tunnelProcess.ExitCode)." }
    }
  } finally {
    Stop-ProcessTree $tunnelProcess
    Stop-ProcessTree $devRelayProcess
    $env:CONTROL_PLANE_API_KEY = $previousApiKey
    $apiKey = $null
  }
}

if ([string]$connection.kind -ne "https") { throw "Unsupported connection setup. Reopen Connection Setup." }

if ([string]$connection.provider -eq "tailscale") {
  $tailscaleExe = Get-DevRelayTailscaleExe
  if (-not $tailscaleExe) { throw "Tailscale is not installed. Reopen Connection Setup." }
  $publicMcpUrl = Get-TailscalePublicUrl $tailscaleExe
  Set-HttpsOAuth $publicMcpUrl
  if ($SetupOnly) { Write-Step "Tailscale Funnel setup is ready."; exit 0 }
  $devRelayProcess = $null
  $funnelProcess = $null
  try {
    $devRelayProcess = Start-DevRelay $nodeExe
    $funnelProcess = Start-TailscaleFunnel $tailscaleExe
    Start-Sleep -Seconds 1
    if ($funnelProcess.HasExited) { throw "Tailscale Funnel exited during startup with code $($funnelProcess.ExitCode)." }
    Write-Host "DevRelay HTTPS is online." -ForegroundColor Green
    Write-Host "  Local MCP:  $McpUrl"
    Write-Host "  Public MCP: $publicMcpUrl"
    while ($true) {
      Start-Sleep -Seconds 1
      if ($devRelayProcess.HasExited) { throw "DevRelay exited with code $($devRelayProcess.ExitCode)." }
      if ($funnelProcess.HasExited) { throw "Tailscale Funnel exited with code $($funnelProcess.ExitCode)." }
    }
  } finally {
    Stop-ProcessTree $funnelProcess
    Invoke-DevRelayExternal $tailscaleExe @("funnel", "reset") -AllowFailure | Out-Null
    Stop-ProcessTree $devRelayProcess
    Clear-HttpsOAuth
  }
}

if ([string]$connection.provider -eq "cloudflare" -and [string]$connection.variant -eq "named") {
  $cloudflaredExe = Ensure-DevRelayCloudflared
  $named = Get-CloudflareNamedSettings
  $named = Get-CloudflareNamedRuntimeSettings $named
  $publicMcpUrl = "https://$([string]$named.hostname)/mcp"
  Set-HttpsOAuth $publicMcpUrl
  if ($SetupOnly) { Write-Step "Cloudflare custom hostname setup is ready."; exit 0 }
  $devRelayProcess = $null
  $tunnelProcess = $null
  try {
    $devRelayProcess = Start-DevRelay $nodeExe
    $tunnelProcess = Start-CloudflareNamed $cloudflaredExe $named
    Write-Host "DevRelay HTTPS is online." -ForegroundColor Green
    Write-Host "  Local MCP:  $McpUrl"
    Write-Host "  Public MCP: $publicMcpUrl"
    while ($true) {
      Start-Sleep -Seconds 1
      if ($devRelayProcess.HasExited) { throw "DevRelay exited with code $($devRelayProcess.ExitCode)." }
      if ($tunnelProcess.HasExited) { throw "cloudflared exited with code $($tunnelProcess.ExitCode)." }
    }
  } finally {
    Stop-ProcessTree $tunnelProcess
    Stop-ProcessTree $devRelayProcess
    Clear-HttpsOAuth
  }
}

if ([string]$connection.provider -eq "cloudflare" -and [string]$connection.variant -eq "quick") {
  $cloudflaredExe = Ensure-DevRelayCloudflared
  if ($SetupOnly) { Write-Step "Cloudflare temporary URL prerequisites are ready."; exit 0 }
  $quick = $null
  $devRelayProcess = $null
  try {
    $quick = Start-CloudflareQuick $cloudflaredExe
    Set-HttpsOAuth $quick.PublicMcpUrl
    $devRelayProcess = Start-DevRelay $nodeExe
    Write-Host "DevRelay HTTPS is online." -ForegroundColor Green
    Write-Host "  Local MCP:  $McpUrl"
    Write-Host "  Public MCP: $($quick.PublicMcpUrl)"
    while ($true) {
      Start-Sleep -Seconds 1
      if ($devRelayProcess.HasExited) { throw "DevRelay exited with code $($devRelayProcess.ExitCode)." }
      if ($quick.Process.HasExited) { throw "Cloudflare temporary URL exited with code $($quick.Process.ExitCode)." }
    }
  } finally {
    if ($quick) { Stop-ProcessTree $quick.Process }
    Stop-ProcessTree $devRelayProcess
    Clear-HttpsOAuth
  }
}

throw "Unsupported HTTPS provider. Reopen Connection Setup."
