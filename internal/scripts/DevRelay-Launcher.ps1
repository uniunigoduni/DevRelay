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
$SessionDir = [string]$env:DEVRELAY_SESSION_DIR
$SessionId = [string]$env:DEVRELAY_SESSION_ID
$ProcessStatePath = if ($SessionDir) { Join-Path $SessionDir "processes.json" } else { $null }
$LauncherLifecyclePath = if ($SessionDir) { Join-Path $SessionDir "launcher-lifecycle.ndjson" } else { $null }
$script:TrackedRuntime = $null
$script:TrackedTunnel = $null
$script:LauncherRecord = $null

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

function Get-ProcessStartedAt($Process) {
  try { return $Process.StartTime.ToUniversalTime().ToString("o") }
  catch { return (Get-Date).ToUniversalTime().ToString("o") }
}
function Get-ParentProcessId([int]$ProcessId) {
  try { return [int](Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId").ParentProcessId }
  catch { return $null }
}
function New-TrackedProcessRecord([string]$Role, $Process, [string]$ExecutablePath, [string[]]$CommandIncludes) {
  if ($null -eq $Process) { return $null }
  return [ordered]@{
    role = $Role
    pid = [int]$Process.Id
    parentPid = Get-ParentProcessId ([int]$Process.Id)
    startedAt = Get-ProcessStartedAt $Process
    executableName = [IO.Path]::GetFileName($ExecutablePath)
    executablePath = $ExecutablePath
    commandIncludes = @($CommandIncludes)
  }
}
function Write-LauncherLifecycle([string]$Event, [hashtable]$Data = @{}) {
  if (-not $LauncherLifecyclePath) { return }
  try {
    $entry = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString("o"); event = $Event; launcherPid = $PID; sessionId = $SessionId }
    foreach ($item in $Data.GetEnumerator()) { $entry[$item.Key] = $item.Value }
    $line = ($entry | ConvertTo-Json -Compress -Depth 8) + [Environment]::NewLine
    [IO.File]::AppendAllText($LauncherLifecyclePath, $line, (New-Object Text.UTF8Encoding($false)))
  } catch {}
}
function Write-SessionProcessState([string]$Status) {
  if (-not $ProcessStatePath) { return }
  try {
    Write-JsonFile $ProcessStatePath ([ordered]@{
      sessionId = $SessionId
      updatedAt = (Get-Date).ToUniversalTime().ToString("o")
      status = $Status
      controllerPid = if ($env:DEVRELAY_CONTROLLER_PID) { [int]$env:DEVRELAY_CONTROLLER_PID } else { $null }
      launcher = $script:LauncherRecord
      runtime = $script:TrackedRuntime
      tunnel = $script:TrackedTunnel
    })
  } catch {}
}
function Set-TrackedProcess([string]$Role, $Process, [string]$ExecutablePath, [string[]]$CommandIncludes) {
  $record = New-TrackedProcessRecord $Role $Process $ExecutablePath $CommandIncludes
  if ($Role -eq "runtime") { $script:TrackedRuntime = $record }
  elseif ($Role -eq "tunnel") { $script:TrackedTunnel = $record }
  Write-LauncherLifecycle "$Role.start" @{ pid = $record.pid; parentPid = $record.parentPid; startedAt = $record.startedAt; executableName = $record.executableName }
  Write-SessionProcessState "running"
  return $Process
}
function Clear-TrackedProcess([int]$ProcessId, [string]$Reason) {
  if ($script:TrackedRuntime -and [int]$script:TrackedRuntime.pid -eq $ProcessId) {
    Write-LauncherLifecycle "runtime.clear" @{ pid = $ProcessId; reason = $Reason }
    $script:TrackedRuntime = $null
  }
  if ($script:TrackedTunnel -and [int]$script:TrackedTunnel.pid -eq $ProcessId) {
    Write-LauncherLifecycle "tunnel.clear" @{ pid = $ProcessId; reason = $Reason }
    $script:TrackedTunnel = $null
  }
  Write-SessionProcessState "running"
}

if ($SessionDir) {
  $current = Get-Process -Id $PID
  $script:LauncherRecord = [ordered]@{
    role = "launcher"
    pid = [int]$PID
    parentPid = Get-ParentProcessId $PID
    startedAt = Get-ProcessStartedAt $current
    executableName = "powershell.exe"
    executablePath = $current.Path
    commandIncludes = @($PSCommandPath, "-Port", [string]$Port)
  }
  Write-SessionProcessState "launcher-started"
  Write-LauncherLifecycle "launcher.start" @{ parentPid = $script:LauncherRecord.parentPid; startedAt = $script:LauncherRecord.startedAt; port = $Port }
}
function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $Root) {
  Push-Location $WorkingDirectory
  $previousPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 can promote native stderr to NativeCommandError when
    # ErrorActionPreference=Stop, even if the native process exits successfully.
    $ErrorActionPreference = "Continue"
    & $FilePath @Arguments 2>&1 | Out-Host
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
    Pop-Location
  }
  if ($code -ne 0) { throw "$FilePath exited with code $code" }
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
  $processId = [int]$Process.Id
  Write-LauncherLifecycle "process.stop-request" @{ pid = $processId }
  try {
    if (-not $Process.HasExited) { & taskkill.exe /PID $processId /T /F 2>$null | Out-Null }
  } catch { try { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue } catch {} }
  finally { Clear-TrackedProcess $processId "stop-tree" }
}
function Start-DevRelay([string]$NodeExe) {
  if (Test-LocalPort $Port) { throw "TCP port $Port is already in use. Stop the existing listener or change the Port setting." }
  $entry = Join-Path $Root "dist\src\main.js"
  Write-Step "Starting DevRelay HTTP MCP at $McpUrl..."
  $process = Start-Process -FilePath $NodeExe -ArgumentList @($entry, "--http", "--host", $HostAddress, "--port", [string]$Port) -WorkingDirectory $Root -NoNewWindow -PassThru
  Set-TrackedProcess "runtime" $process $NodeExe @($entry, "--http", "--host", $HostAddress, "--port", [string]$Port) | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { Write-LauncherLifecycle "runtime.exit" @{ pid = $process.Id; exitCode = $process.ExitCode; phase = "startup" }; Write-SessionProcessState "runtime-exited"; throw "DevRelay exited during startup with code $($process.ExitCode)." }
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
  $process = Start-Process -FilePath $Exe -ArgumentList @("funnel", "--yes", "--https=443", "127.0.0.1:$Port") -WorkingDirectory $Root -NoNewWindow -PassThru
  Set-TrackedProcess "tunnel" $process $Exe @("funnel", "--https=443", "127.0.0.1:$Port") | Out-Null
  return $process
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
  Set-TrackedProcess "tunnel" $process $Exe @("tunnel", $logPath, [string]$Settings.tunnelName) | Out-Null
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) {
      $details = if (Test-Path $logPath) { Get-Content -Raw $logPath } else { "" }
      Write-LauncherLifecycle "tunnel.exit" @{ pid = $process.Id; exitCode = $process.ExitCode; provider = "cloudflare"; phase = "startup" }
      Write-SessionProcessState "tunnel-exited"
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
  Set-TrackedProcess "tunnel" $process $Exe @("tunnel", "--url", "http://${HostAddress}:$Port", $logPath) | Out-Null
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { Write-LauncherLifecycle "tunnel.exit" @{ pid = $process.Id; exitCode = $process.ExitCode; provider = "cloudflare-quick"; phase = "startup" }; Write-SessionProcessState "tunnel-exited"; throw "cloudflared temporary URL exited during startup with code $($process.ExitCode)." }
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
function Start-TunnelWithStartupRecovery($RuntimeProcess, [string]$Provider, [scriptblock]$StartTunnel) {
  $initialFailure = $null
  try {
    $tunnel = & $StartTunnel
    if ($null -eq $tunnel -or $tunnel.HasExited) { throw "$Provider tunnel exited during startup." }
    return $tunnel
  } catch {
    $initialFailure = [string]$_
    if ($initialFailure -match '(?i)not installed|not signed in|missing|incomplete|invalid credentials|invalid token|authentication failed|unauthorized|permission denied|access denied|invalid configuration|no such file|unsupported') { throw }
  }
  Write-Step "$Provider tunnel startup failed ($initialFailure); retrying for up to three minutes."
  $startedAt = Get-Date
  $retryDelays = @(1, 2, 4, 8, 15, 30)
  for ($attempt = 1; ((Get-Date) - $startedAt).TotalSeconds -lt 180; $attempt++) {
    $remaining = [Math]::Max(0, 180 - ((Get-Date) - $startedAt).TotalSeconds)
    $delay = [Math]::Min($retryDelays[[Math]::Min($attempt - 1, $retryDelays.Count - 1)], $remaining)
    Write-LauncherLifecycle "tunnel.recovery-retry" @{ provider = $Provider; phase = "startup"; attempt = $attempt; delayMs = [int]($delay * 1000) }
    $until = (Get-Date).AddSeconds($delay)
    while ((Get-Date) -lt $until) {
      if ($RuntimeProcess.HasExited) { throw "DevRelay exited while reconnecting the tunnel, code $($RuntimeProcess.ExitCode)." }
      Start-Sleep -Milliseconds 250
    }
    if (((Get-Date) - $startedAt).TotalSeconds -ge 180) { break }
    try {
      $tunnel = & $StartTunnel
      if ($null -eq $tunnel -or $tunnel.HasExited) { throw "$Provider tunnel exited during reconnection startup." }
      if (((Get-Date) - $startedAt).TotalSeconds -gt 180) {
        Stop-ProcessTree $tunnel
        throw "Tunnel became ready after the startup recovery deadline."
      }
      Write-LauncherLifecycle "tunnel.recovery-success" @{ provider = $Provider; phase = "startup"; attempt = $attempt; pid = $tunnel.Id }
      Write-Step "$Provider tunnel restored after $attempt attempt(s)."
      return $tunnel
    } catch {
      $message = [string]$_
      Write-LauncherLifecycle "tunnel.recovery-failure" @{ provider = $Provider; phase = "startup"; attempt = $attempt; message = $message }
      if ($message -match '(?i)not installed|not signed in|missing|incomplete|invalid credentials|invalid token|authentication failed|unauthorized|permission denied|access denied|invalid configuration|no such file|unsupported') { throw }
    }
  }
  Write-LauncherLifecycle "tunnel.recovery-timeout" @{ provider = $Provider; phase = "startup"; attempts = $attempt - 1 }
  throw "$Provider tunnel startup recovery timed out after 180 seconds."
}

function Wait-TunnelWithRecovery($RuntimeProcess, [ref]$CurrentTunnel, [string]$Provider, [scriptblock]$StartTunnel) {
  # The budget survives consecutive short-lived reconnections, and resets after 60 seconds online.
  $recoveryStart = $null
  $attempt = 0
  $lastConnectedAt = Get-Date
  $retryDelays = @(1, 2, 4, 8, 15, 30)
  while ($true) {
    Start-Sleep -Seconds 1
    if ($RuntimeProcess.HasExited) {
      Write-LauncherLifecycle "runtime.exit" @{ pid = $RuntimeProcess.Id; exitCode = $RuntimeProcess.ExitCode }
      Write-SessionProcessState "runtime-exited"
      throw "DevRelay exited with code $($RuntimeProcess.ExitCode)."
    }
    if (-not $CurrentTunnel.Value.HasExited) { continue }
    $exited = $CurrentTunnel.Value
    $exitCode = $exited.ExitCode
    Write-LauncherLifecycle "tunnel.exit" @{ pid = $exited.Id; exitCode = $exitCode; provider = $Provider }
    Write-SessionProcessState "tunnel-exited"
    if ($null -eq $recoveryStart -or ((Get-Date) - $lastConnectedAt).TotalSeconds -ge 60) {
      $recoveryStart = Get-Date
      $attempt = 0
      Write-LauncherLifecycle "tunnel.recovery-begin" @{ provider = $Provider; exitCode = $exitCode; deadlineMs = 180000 }
    }
    Write-Step "$Provider tunnel exited with code $exitCode; keeping MCP runtime online during recovery."
    $connected = $false
    while (((Get-Date) - $recoveryStart).TotalSeconds -lt 180) {
      $attempt++
      $delay = $retryDelays[[Math]::Min($attempt - 1, $retryDelays.Count - 1)]
      $remaining = [Math]::Max(0, 180 - ((Get-Date) - $recoveryStart).TotalSeconds)
      $delay = [Math]::Min($delay, $remaining)
      Write-LauncherLifecycle "tunnel.recovery-retry" @{ provider = $Provider; attempt = $attempt; delayMs = [int]($delay * 1000) }
      $until = (Get-Date).AddSeconds($delay)
      while ((Get-Date) -lt $until) {
        if ($RuntimeProcess.HasExited) { throw "DevRelay exited while reconnecting the tunnel, code $($RuntimeProcess.ExitCode)." }
        Start-Sleep -Milliseconds 250
      }
      if (((Get-Date) - $recoveryStart).TotalSeconds -ge 180) { break }
      try {
        $replacement = & $StartTunnel
        if ($null -eq $replacement -or $replacement.HasExited) { throw "Tunnel exited during reconnection startup." }
        if (((Get-Date) - $recoveryStart).TotalSeconds -gt 180) {
          Stop-ProcessTree $replacement
          throw "Tunnel became ready after the recovery deadline."
        }
        $CurrentTunnel.Value = $replacement
        $lastConnectedAt = Get-Date
        $connected = $true
        Write-SessionProcessState "running"
        Write-LauncherLifecycle "tunnel.recovery-success" @{ provider = $Provider; attempt = $attempt; pid = $replacement.Id }
        Write-Step "$Provider tunnel restored after $attempt attempt(s)."
        break
      } catch {
        $message = [string]$_
        Write-LauncherLifecycle "tunnel.recovery-failure" @{ provider = $Provider; attempt = $attempt; message = $message }
        Write-Step "$Provider reconnect attempt $attempt failed: $message"
        if ($message -match '(?i)not installed|not signed in|missing|incomplete|invalid credentials|invalid token|authentication failed|unauthorized|permission denied|access denied|invalid configuration|no such file|unsupported') { throw }
      }
    }
    if (-not $connected) {
      Write-LauncherLifecycle "tunnel.recovery-timeout" @{ provider = $Provider; attempts = $attempt }
      throw "$Provider tunnel recovery timed out after 180 seconds ($attempt attempts)."
    }
  }
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
    Write-LauncherLifecycle "runtime.exit" @{ pid = $devRelayProcess.Id; exitCode = $devRelayProcess.ExitCode; provider = "local" }
    Write-SessionProcessState "runtime-exited"
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
    $tunnelProcess = Start-TunnelWithStartupRecovery $devRelayProcess "openai" {
      $newTunnel = Start-Process -FilePath $tunnelExe -ArgumentList @("run", "--profile", $Profile, "--profile-dir", $ProfileDir) -WorkingDirectory $Root -NoNewWindow -PassThru
      Set-TrackedProcess "tunnel" $newTunnel $tunnelExe @("run", "--profile", $Profile, "--profile-dir", $ProfileDir) | Out-Null
      Start-Sleep -Seconds 1
      if ($newTunnel.HasExited) { throw "OpenAI tunnel-client exited during startup with code $($newTunnel.ExitCode)." }
      return $newTunnel
    }
    Write-Host "DevRelay is online for ChatGPT." -ForegroundColor Green
    Write-Host "  Local MCP: $McpUrl"
    Write-Host "  Tunnel ID: $([string]$config.tunnelId)"
    Wait-TunnelWithRecovery $devRelayProcess ([ref]$tunnelProcess) "openai" {
      Invoke-OpenAIDoctor $tunnelExe $apiKey
      $newTunnel = Start-Process -FilePath $tunnelExe -ArgumentList @("run", "--profile", $Profile, "--profile-dir", $ProfileDir) -WorkingDirectory $Root -NoNewWindow -PassThru
      Set-TrackedProcess "tunnel" $newTunnel $tunnelExe @("run", "--profile", $Profile, "--profile-dir", $ProfileDir) | Out-Null
      Start-Sleep -Seconds 1
      if ($newTunnel.HasExited) { throw "OpenAI tunnel-client exited during reconnection with code $($newTunnel.ExitCode)." }
      return $newTunnel
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
    $funnelProcess = Start-TunnelWithStartupRecovery $devRelayProcess "tailscale" {
      $newTunnel = Start-TailscaleFunnel $tailscaleExe
      Start-Sleep -Seconds 1
      if ($newTunnel.HasExited) { throw "Tailscale Funnel exited during startup with code $($newTunnel.ExitCode)." }
      return $newTunnel
    }
    Write-Host "DevRelay HTTPS is online." -ForegroundColor Green
    Write-Host "  Local MCP:  $McpUrl"
    Write-Host "  Public MCP: $publicMcpUrl"
    Wait-TunnelWithRecovery $devRelayProcess ([ref]$funnelProcess) "tailscale" {
      $newTunnel = Start-TailscaleFunnel $tailscaleExe
      Start-Sleep -Seconds 1
      if ($newTunnel.HasExited) { throw "Tailscale Funnel exited during reconnection with code $($newTunnel.ExitCode)." }
      return $newTunnel
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
    $tunnelProcess = Start-TunnelWithStartupRecovery $devRelayProcess "cloudflare" {
      Start-CloudflareNamed $cloudflaredExe $named
    }
    Write-Host "DevRelay HTTPS is online." -ForegroundColor Green
    Write-Host "  Local MCP:  $McpUrl"
    Write-Host "  Public MCP: $publicMcpUrl"
    Wait-TunnelWithRecovery $devRelayProcess ([ref]$tunnelProcess) "cloudflare" {
      Start-CloudflareNamed $cloudflaredExe $named
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
      if ($devRelayProcess.HasExited) { Write-LauncherLifecycle "runtime.exit" @{ pid = $devRelayProcess.Id; exitCode = $devRelayProcess.ExitCode }; Write-SessionProcessState "runtime-exited"; throw "DevRelay exited with code $($devRelayProcess.ExitCode)." }
      if ($quick.Process.HasExited) { Write-LauncherLifecycle "tunnel.exit" @{ pid = $quick.Process.Id; exitCode = $quick.Process.ExitCode; provider = "cloudflare-quick" }; Write-SessionProcessState "tunnel-exited"; throw "Cloudflare temporary URL exited with code $($quick.Process.ExitCode)." }
    }
  } finally {
    if ($quick) { Stop-ProcessTree $quick.Process }
    Stop-ProcessTree $devRelayProcess
    Clear-HttpsOAuth
  }
}

throw "Unsupported HTTPS provider. Reopen Connection Setup."
