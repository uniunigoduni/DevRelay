[CmdletBinding()]
param(
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$InternalRoot = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $InternalRoot
$StateDir = Join-Path $InternalRoot ".devrelay"
$StatePath = Join-Path $StateDir "update-state.json"
$Repository = "uniunigoduni/DevRelay"
$LatestReleaseApi = "https://api.github.com/repos/$Repository/releases/latest"
$TempRef = "refs/devrelay-update/latest"

function Ensure-StateDir {
  [IO.Directory]::CreateDirectory($StateDir) | Out-Null
}

function Write-UpdateState([string]$Status, [string]$Message, [string]$Tag = "", [string]$FromCommit = "", [string]$ToCommit = "", [bool]$Updated = $false) {
  Ensure-StateDir
  $value = [ordered]@{
    checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    status = $Status
    updated = $Updated
    message = $Message
  }
  if ($Tag) { $value.tag = $Tag }
  if ($FromCommit) { $value.fromCommit = $FromCommit }
  if ($ToCommit) { $value.toCommit = $ToCommit }
  $json = $value | ConvertTo-Json -Depth 4 -Compress
  [IO.File]::WriteAllText($StatePath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  return $value
}

function Invoke-Git([string[]]$Arguments, [switch]$AllowFailure) {
  $output = & git.exe -C $ProjectRoot @Arguments 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "git $($Arguments -join ' ') failed with exit code ${code}: $($output -join ' ')"
  }
  return [pscustomobject]@{ Code = $code; Output = @($output) }
}

function Finish($State) {
  if ($DryRun) { $State | ConvertTo-Json -Depth 4 -Compress | Write-Output }
  exit 0
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot ".git"))) {
    Finish (Write-UpdateState "skipped" "Automatic release updates require a Git checkout.")
  }
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    Finish (Write-UpdateState "skipped" "Git is not available; release update check skipped.")
  }

  $originResult = Invoke-Git @( "remote", "get-url", "origin" )
  $origin = (($originResult.Output -join "").Trim())
  $officialOrigins = @(
    "https://github.com/uniunigoduni/DevRelay.git",
    "https://github.com/uniunigoduni/DevRelay",
    "git@github.com:uniunigoduni/DevRelay.git",
    "git@github.com:uniunigoduni/DevRelay",
    "ssh://git@github.com/uniunigoduni/DevRelay.git",
    "ssh://git@github.com/uniunigoduni/DevRelay"
  )
  if (-not ($officialOrigins -contains $origin)) {
    Finish (Write-UpdateState "skipped" "Origin is not the official DevRelay repository; automatic update skipped.")
  }

  $dirty = Invoke-Git @( "status", "--porcelain" )
  if (($dirty.Output -join "").Trim()) {
    Finish (Write-UpdateState "skipped" "Working tree is not clean; automatic update skipped.")
  }

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Method Get -Uri $LatestReleaseApi -Headers @{
      "User-Agent" = "DevRelay-Updater"
      "Accept" = "application/vnd.github+json"
      "X-GitHub-Api-Version" = "2026-03-10"
    } -TimeoutSec 4
  } catch {
    $response = $_.Exception.Response
    if ($response -and [int]$response.StatusCode -eq 404) {
      Finish (Write-UpdateState "none" "No published GitHub Release is available yet; continuing without an update.")
    }
    Finish (Write-UpdateState "unavailable" "Latest release could not be checked; continuing without an update.")
  }

  $tag = [string]$release.tag_name
  if ([string]::IsNullOrWhiteSpace($tag)) {
    Finish (Write-UpdateState "unavailable" "Latest release did not provide a tag; continuing without an update.")
  }
  if ([bool]$release.draft -or [bool]$release.prerelease) {
    Finish (Write-UpdateState "skipped" "Latest API result is not a published full release; update skipped." $tag)
  }
  $tagRef = "refs/tags/$tag"
  $validTag = Invoke-Git @( "check-ref-format", $tagRef ) -AllowFailure
  if ($validTag.Code -ne 0) {
    Finish (Write-UpdateState "error" "Latest release tag is not a valid Git ref; update skipped safely." $tag)
  }

  $head = ((Invoke-Git @( "rev-parse", "HEAD" )).Output -join "").Trim()
  if ($DryRun) {
    Finish (Write-UpdateState "checked" "Latest published release found. Dry run did not fetch or modify refs." $tag $head "")
  }

  try {
    Invoke-Git @( "update-ref", "-d", $TempRef ) -AllowFailure | Out-Null
    Invoke-Git @( "fetch", "--quiet", "origin", "refs/tags/${tag}:$TempRef" ) | Out-Null
    $releaseCommit = ((Invoke-Git @( "rev-list", "-n", "1", $TempRef )).Output -join "").Trim()
    if (-not $releaseCommit) { throw "Release tag did not resolve to a commit." }

    if ($head -eq $releaseCommit) {
      Finish (Write-UpdateState "current" "Already on the latest published release." $tag $head $releaseCommit)
    }

    $ancestor = Invoke-Git @( "merge-base", "--is-ancestor", $head, $releaseCommit ) -AllowFailure
    if ($ancestor.Code -ne 0) {
      Finish (Write-UpdateState "skipped" "Current checkout is ahead of or diverged from the latest release; no downgrade or non-fast-forward update was attempted." $tag $head $releaseCommit)
    }

    Invoke-Git @( "merge", "--ff-only", $releaseCommit ) | Out-Null

    $prepareScript = Join-Path $InternalRoot "scripts\DevRelay-Launcher.ps1"
    if (Test-Path -LiteralPath $prepareScript) {
      & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $prepareScript -SetupOnly -NoTunnel | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Updated source was applied, but release setup failed with exit code $LASTEXITCODE." }
    }

    Finish (Write-UpdateState "updated" "Updated to the latest published release and prepared the local build." $tag $head $releaseCommit $true)
  } finally {
    Invoke-Git @( "update-ref", "-d", $TempRef ) -AllowFailure | Out-Null
  }
} catch {
  Finish (Write-UpdateState "error" ("Release update failed safely: " + $_.Exception.Message))
}
