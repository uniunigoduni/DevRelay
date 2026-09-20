[CmdletBinding()]
param(
  [switch]$SetupOnly,
  [switch]$NoTunnel,
  [switch]$HttpsDirect,
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
$ConfigPath = Join-Path $StateDir "launcher.json"
$SecretPath = Join-Path $StateDir "control-plane-api-key.dpapi"
$ProfileDir = Join-Path $StateDir "tunnel-profiles"
$ToolDir = Join-Path $Root "tools\tunnel-client"
$TunnelExe = Join-Path $ToolDir "tunnel-client.exe"
$CloudflaredExe = Join-Path $ToolDir "cloudflared.exe"
$HostAddress = "127.0.0.1"
$McpUrl = "http://${HostAddress}:$Port/mcp"

function Write-Step([string]$Message) {
  Write-Host "[DevRelay] $Message" -ForegroundColor Cyan
}
function Ensure-Directory([string]$Path) {
  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $Root) {
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$FilePath exited with code $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  $raw = Get-Content -Raw -Path $Path
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json
}

function Write-JsonFile([string]$Path, $Value) {
  $json = $Value | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
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
  $inputs = @(
    (Join-Path $Root "package.json"),
    (Join-Path $Root "tsconfig.json")
  )
  $inputs += Get-ChildItem (Join-Path $Root "src") -Filter *.ts -Recurse | Select-Object -ExpandProperty FullName
  foreach ($input in $inputs) {
    if ((Get-Item $input).LastWriteTimeUtc -gt $builtAt) { return $true }
  }
  return $false
}

function Ensure-Build {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $node -or -not $npm) {
    throw "Node.js 20+ and npm are required. Install Node.js, then rerun one of the DevRelay launchers."
  }

  $state = Read-JsonFile $StatePath
  $lockHash = Get-LockHash
  $installedHash = [string](Get-ObjectValue $state "packageLockHash" "")
  $nodeModules = Join-Path $Root "node_modules"
  if ($ForceSetup -or -not (Test-Path $nodeModules) -or $installedHash -ne $lockHash) {
    Write-Step "Installing npm dependencies..."
    Invoke-Checked $npm.Source @("ci")
  }
  else {
    Write-Step "npm dependencies are already installed."
  }

  if ($ForceSetup -or (Build-Is-Stale)) {
    Write-Step "Building DevRelay..."
    Invoke-Checked $npm.Source @("run", "build")
  }
  else {
    Write-Step "Build is already current."
  }

  Write-JsonFile $StatePath ([ordered]@{
    packageLockHash = $lockHash
    lastPreparedAt = (Get-Date).ToUniversalTime().ToString("o")
  })

  return $node.Source
}

function Get-WindowsArchitecture {
  $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($arch -eq "arm64") { return "arm64" }
  if ($arch -eq "x64") { return "amd64" }
  throw "Unsupported Windows architecture: $arch"
}
function Ensure-TunnelClient {
  if ((Test-Path $TunnelExe) -and (Test-Path (Join-Path $ToolDir "cloudflared.exe")) -and -not $ForceSetup) {
    Write-Step "tunnel-client is already installed locally."
    return $TunnelExe
  }

  Ensure-Directory $ToolDir
  $arch = Get-WindowsArchitecture
  Write-Step "Resolving the latest official OpenAI tunnel-client for windows-$arch..."
  $headers = @{ "User-Agent" = "DevRelay-Launcher" }
  $release = Invoke-RestMethod -UseBasicParsing -Headers $headers `
    -Uri "https://api.github.com/repos/openai/tunnel-client/releases/latest"
  $pattern = "^tunnel-client-v[0-9].*-windows-$arch\.zip$"
  $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) {
    throw "No official tunnel-client Windows asset matched $pattern"
  }

  $tempRoot = Join-Path $env:TEMP ("devrelay-tunnel-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempRoot $asset.name
  $extractDir = Join-Path $tempRoot "extract"
  Ensure-Directory $tempRoot
  try {
    Write-Step "Downloading $($asset.name)..."
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zipPath
    if ($asset.digest -and ([string]$asset.digest).StartsWith("sha256:")) {
      $expected = ([string]$asset.digest).Substring(7).ToUpperInvariant()
      $actual = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToUpperInvariant()
      if ($actual -ne $expected) {
        throw "tunnel-client archive checksum mismatch."
      }
      Write-Step "Verified tunnel-client SHA-256."
    }

    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    $candidate = Get-ChildItem $extractDir -Recurse -Filter "tunnel-client.exe" | Select-Object -First 1
    if (-not $candidate) {
      throw "Downloaded archive did not contain tunnel-client.exe"
    }
    Get-ChildItem $ToolDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Copy-Item (Join-Path $candidate.DirectoryName "*") $ToolDir -Recurse -Force
    Write-Step "Installed tunnel-client $($release.tag_name) and its bundled runtime to tools\tunnel-client."
  }
  finally {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  return $TunnelExe
}

function Convert-SecureToPlain([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Get-ControlPlaneApiKey {
  if (-not [string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
    Write-Step "Using CONTROL_PLANE_API_KEY from the current environment."
    return $env:CONTROL_PLANE_API_KEY
  }

  if ((Test-Path $SecretPath) -and -not $ResetTunnel) {
    try {
      $encrypted = (Get-Content -Raw $SecretPath).Trim()
      $secure = ConvertTo-SecureString $encrypted
      $plain = Convert-SecureToPlain $secure
      if (-not [string]::IsNullOrWhiteSpace($plain)) {
        Write-Step "Loaded the tunnel runtime key from Windows DPAPI storage."
        return $plain
      }
    }
    catch {
      Write-Warning "The saved tunnel API key could not be decrypted; it will be requested again."
    }
  }

  Write-Host "Create a runtime API key with Tunnels Read + Use permission:" -ForegroundColor Yellow
  Write-Host "  https://platform.openai.com/settings/organization/api-keys"
  Start-Process "https://platform.openai.com/settings/organization/api-keys" -ErrorAction SilentlyContinue
  $secureInput = Read-Host "Paste CONTROL_PLANE_API_KEY (input is hidden)" -AsSecureString
  $plainInput = Convert-SecureToPlain $secureInput
  if ([string]::IsNullOrWhiteSpace($plainInput)) { throw "An API key is required for Secure MCP Tunnel." }
  $secureInput | ConvertFrom-SecureString | Set-Content -Path $SecretPath -Encoding UTF8
  Write-Step "Saved the runtime key encrypted with Windows DPAPI for this user."
  return $plainInput
}
function Get-ObjectValue($Object, [string]$Name, $Default = $null) {
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function Get-TunnelConfiguration {
  $existing = Read-JsonFile $ConfigPath
  $tunnelId = [string](Get-ObjectValue $existing "tunnelId" "")
  $storedProfile = [string](Get-ObjectValue $existing "profile" "")
  $storedUrl = [string](Get-ObjectValue $existing "mcpUrl" "")
  $needsInit = $ForceSetup -or $ResetTunnel -or ($storedProfile -ne $Profile) -or ($storedUrl -ne $McpUrl)

  if ([string]::IsNullOrWhiteSpace($tunnelId) -or $ResetTunnel) {
    Write-Host "Create or select a Secure MCP Tunnel, then paste its tunnel_id." -ForegroundColor Yellow
    Write-Host "  https://platform.openai.com/settings/organization/tunnels"
    Start-Process "https://platform.openai.com/settings/organization/tunnels" -ErrorAction SilentlyContinue
    $tunnelId = (Read-Host "Tunnel ID (tunnel_...)").Trim()
    $needsInit = $true
  }

  if ($tunnelId -notmatch '^tunnel_[a-z0-9]{32}$') {
    throw "Invalid tunnel ID. Expected tunnel_ followed by 32 lowercase letters or digits."
  }

  Write-JsonFile $ConfigPath ([ordered]@{
    profile = $Profile
    tunnelId = $tunnelId
    mcpUrl = $McpUrl
  })
  return [pscustomobject]@{ TunnelId = $tunnelId; NeedsInit = $needsInit }
}
function Ensure-TunnelProfile([string]$Exe, $TunnelConfig) {
  Ensure-Directory $ProfileDir
  $profileFile = Join-Path $ProfileDir ($Profile + ".yaml")
  $needsInit = [bool]$TunnelConfig.NeedsInit -or -not (Test-Path $profileFile)
  if (-not $needsInit) {
    Write-Step "Tunnel profile '$Profile' is already configured."
    return $false
  }

  Write-Step "Creating tunnel profile '$Profile' for $McpUrl..."
  $args = @(
    "init",
    "--sample", "sample_mcp_remote_no_auth",
    "--profile", $Profile,
    "--profile-dir", $ProfileDir,
    "--tunnel-id", [string]$TunnelConfig.TunnelId,
    "--mcp-server-url", $McpUrl,
    "--health-listen-addr", "127.0.0.1:0",
    "--force"
  )
  Invoke-Checked $Exe $args
  return $true
}

function Test-LocalPort([int]$TestPort, [int]$TimeoutMs = 500) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($HostAddress, $TestPort, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($async)
    return $client.Connected
  }
  catch { return $false }
  finally { $client.Close() }
}
function Stop-ProcessTree($Process) {
  if ($null -eq $Process) { return }
  try {
    if (-not $Process.HasExited) {
      & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    }
  }
  catch {
    try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Start-DevRelay([string]$NodeExe) {
  if (Test-LocalPort $Port) {
    throw "TCP port $Port is already in use. Stop the existing listener or launch with -Port <port>."
  }

  $entry = Join-Path $Root "dist\src\main.js"
  Write-Step "Starting DevRelay HTTP MCP at $McpUrl..."
  $arguments = @($entry, "--http", "--host", $HostAddress, "--port", [string]$Port)
  $process = Start-Process -FilePath $NodeExe -ArgumentList $arguments `
    -WorkingDirectory $Root -NoNewWindow -PassThru

  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) {
      throw "DevRelay exited during startup with code $($process.ExitCode)."
    }
    if (Test-LocalPort $Port) {
      Write-Step "DevRelay is ready."
      return $process
    }
  }

  Stop-ProcessTree $process
  throw "DevRelay did not become ready on $McpUrl."
}
function Invoke-TunnelDoctor([string]$Exe) {
  Write-Step "Validating the Secure MCP Tunnel profile..."
  Invoke-Checked $Exe @(
    "doctor",
    "--profile", $Profile,
    "--profile-dir", $ProfileDir,
    "--explain"
  )
}

function Start-Tunnel([string]$Exe) {
  Write-Step "Starting OpenAI Secure MCP Tunnel..."
  $arguments = @("run", "--profile", $Profile, "--profile-dir", $ProfileDir)
  $process = Start-Process -FilePath $Exe -ArgumentList $arguments `
    -WorkingDirectory $Root -NoNewWindow -PassThru
  Start-Sleep -Seconds 1
  if ($process.HasExited) {
    throw "tunnel-client exited during startup with code $($process.ExitCode)."
  }
  Write-Step "Secure MCP Tunnel is running."
  return $process
}

function Start-HttpsTunnel([string]$CloudflaredPath) {
  if (-not (Test-Path $CloudflaredPath)) { throw "cloudflared.exe was not found." }
  $settingsPath = Join-Path $StateDir "https-named.json"
  if (-not (Test-Path $settingsPath)) { throw "Cloudflare Named Tunnel settings were not found at $settingsPath" }
  $settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
  $tunnelName = [string]$settings.tunnelName
  $hostname = [string]$settings.hostname
  $namedConfig = [string]$settings.configPath
  if (-not $tunnelName -or -not $hostname -or -not $namedConfig) { throw "Named Tunnel settings are incomplete." }
  if (-not (Test-Path $namedConfig)) { throw "Cloudflare Named Tunnel config was not found at $namedConfig" }
  $logPath = Join-Path $StateDir "cloudflared-named.log"
  Remove-Item $logPath -Force -ErrorAction SilentlyContinue
  $baseUrl = "https://$hostname"
  Write-Step "Starting Cloudflare Named Tunnel for $baseUrl..."
  $arguments = @("tunnel", "--config", $namedConfig, "--loglevel", "info", "--logfile", $logPath, "run", $tunnelName)
  $process = Start-Process -FilePath $CloudflaredPath -ArgumentList $arguments -WorkingDirectory $Root -NoNewWindow -PassThru
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) {
      $details = if (Test-Path $logPath) { Get-Content -Raw $logPath } else { "" }
      throw "cloudflared exited during startup with code $($process.ExitCode). $details"
    }
    if ((Test-Path $logPath) -and ((Get-Content -Raw $logPath) -match 'Registered tunnel connection')) {
      return [pscustomobject]@{ Process = $process; BaseUrl = $baseUrl; McpUrl = "$baseUrl/mcp"; LogPath = $logPath }
    }
  }
  Stop-ProcessTree $process
  throw "Cloudflare Named Tunnel did not become ready within 20 seconds. See $logPath"
}

function Show-LauncherStatus {
  Write-Host "DevRelay launcher status" -ForegroundColor Cyan
  Write-Host "  Root:          $Root"
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  Write-Host "  Node:          $(if ($node) { $node.Source } else { 'missing' })"
  Write-Host "  node_modules:  $(if (Test-Path (Join-Path $Root 'node_modules')) { 'present' } else { 'missing' })"
  Write-Host "  Build:         $(if (Build-Is-Stale) { 'missing/stale' } else { 'current' })"
  Write-Host "  MCP endpoint:  $McpUrl"
  Write-Host "  MCP listener:  $(if (Test-LocalPort $Port) { 'listening' } else { 'stopped' })"
  Write-Host "  tunnel-client: $(if (Test-Path $TunnelExe) { $TunnelExe } else { 'not installed locally' })"
  Write-Host "  tunnel config: $(if (Test-Path $ConfigPath) { 'configured' } else { 'not configured' })"
  Write-Host "  runtime key:   $(if (Test-Path $SecretPath) { 'saved with Windows DPAPI' } elseif ($env:CONTROL_PLANE_API_KEY) { 'provided by environment' } else { 'not configured' })"
}
Ensure-Directory $StateDir

if ($ResetTunnel) {
  Write-Step "Resetting saved tunnel configuration and runtime key..."
  Remove-Item $ConfigPath -Force -ErrorAction SilentlyContinue
  Remove-Item $SecretPath -Force -ErrorAction SilentlyContinue
  Remove-Item $ProfileDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($Status) {
  Show-LauncherStatus
  exit 0
}

$nodeExe = Ensure-Build

if ($HttpsDirect) {
  [void](Ensure-TunnelClient)
  if ($SetupOnly) {
    Write-Step "HTTPS direct-mode prerequisites are ready."
    exit 0
  }

  $devRelayProcess = $null
  $httpsTunnel = $null
  try {
    $devRelayProcess = Start-DevRelay $nodeExe
    $httpsTunnel = Start-HttpsTunnel $CloudflaredExe
    try { Set-Clipboard -Value $httpsTunnel.McpUrl -ErrorAction Stop } catch {}
    Write-Host ""
    Write-Host "DevRelay HTTPS is online." -ForegroundColor Green
    Write-Host "  Local MCP:  $McpUrl"
    Write-Host "  Public MCP: $($httpsTunnel.McpUrl)"
    Write-Host ""
    Write-Host "The public MCP URL was copied to the clipboard."
    Write-Host "The fixed MCP URL above was copied to the clipboard."
    Write-Host "Press Ctrl+C to stop DevRelay and the HTTPS tunnel."

    while ($true) {
      Start-Sleep -Seconds 1
      if ($devRelayProcess.HasExited) { throw "DevRelay exited with code $($devRelayProcess.ExitCode)." }
      if ($httpsTunnel.Process.HasExited) { throw "cloudflared exited with code $($httpsTunnel.Process.ExitCode)." }
    }
  }
  finally {
    Write-Step "Stopping HTTPS launcher-managed processes..."
    if ($null -ne $httpsTunnel) { Stop-ProcessTree $httpsTunnel.Process }
    Stop-ProcessTree $devRelayProcess
  }
}

if ($NoTunnel) {
  if ($SetupOnly) {
    Write-Step "Local DevRelay build/setup is complete. Tunnel setup was skipped."
    exit 0
  }

  $devRelayProcess = $null
  try {
    $devRelayProcess = Start-DevRelay $nodeExe
    Write-Host ""
    Write-Host "DevRelay is running locally at $McpUrl" -ForegroundColor Green
    Write-Host "Press Ctrl+C to stop it."
    while (-not $devRelayProcess.HasExited) { Start-Sleep -Seconds 1 }
    throw "DevRelay exited with code $($devRelayProcess.ExitCode)."
  }
  finally {
    Stop-ProcessTree $devRelayProcess
  }
}
$tunnelExePath = Ensure-TunnelClient
$tunnelConfig = Get-TunnelConfiguration
$runtimeApiKey = Get-ControlPlaneApiKey
$previousApiKey = $env:CONTROL_PLANE_API_KEY
$env:CONTROL_PLANE_API_KEY = $runtimeApiKey

$devRelayProcess = $null
$tunnelProcess = $null
try {
  [void](Ensure-TunnelProfile $tunnelExePath $tunnelConfig)
  $devRelayProcess = Start-DevRelay $nodeExe
  Invoke-TunnelDoctor $tunnelExePath

  if ($SetupOnly) {
    Write-Step "Setup and tunnel validation completed successfully."
    exit 0
  }

  $tunnelProcess = Start-Tunnel $tunnelExePath
  Write-Host ""
  Write-Host "DevRelay is online for ChatGPT." -ForegroundColor Green
  Write-Host "  Local MCP: $McpUrl"
  Write-Host "  Tunnel ID: $($tunnelConfig.TunnelId)"
  Write-Host "  Profile:   $Profile"
  Write-Host "Press Ctrl+C to stop DevRelay and the tunnel."

  while ($true) {
    Start-Sleep -Seconds 1
    if ($devRelayProcess.HasExited) {
      throw "DevRelay exited with code $($devRelayProcess.ExitCode)."
    }
    if ($tunnelProcess.HasExited) {
      throw "tunnel-client exited with code $($tunnelProcess.ExitCode)."
    }
  }
}
finally {
  Write-Step "Stopping launcher-managed processes..."
  Stop-ProcessTree $tunnelProcess
  Stop-ProcessTree $devRelayProcess
  $env:CONTROL_PLANE_API_KEY = $previousApiKey
  $runtimeApiKey = $null
}
