[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ProfileId,
  [Parameter(Mandatory=$true)][string]$Message,
  [Parameter(Mandatory=$false)][string]$Source = "fleet-worker",
  [Parameter(Mandatory=$false)][string]$Url = "",
  [Parameter(Mandatory=$false)][string[]]$Targets = @("mastodon", "bluesky", "nostr", "matrix"),
  [Parameter(Mandatory=$false)][string]$ScheduledFor = "",
  [Parameter(Mandatory=$false)][string]$ApiKey = "",
  [switch]$DryRun
)

$targetEndpoint = "http://127.0.0.1:7420/api/ingest/fleet"
$key = if ($ApiKey) { $ApiKey } else { $env:PENNANT_FLEET_INGEST_KEY }
if (-not $key) { $key = "ps_ingest_dev_key" }

$payload = @{
  source       = $Source
  profileId    = $ProfileId
  message      = $Message
  url          = $Url
  targets      = $Targets
  scheduledFor = $ScheduledFor
} | ConvertTo-Json -Compress

if ($DryRun) {
  Write-Host "[DRY-RUN] Fleet Ingest payload for $ProfileId (source:$Source):" -ForegroundColor Cyan
  Write-Host $payload
  exit 0
}

try {
  $headers = @{
    "Authorization" = "Bearer $key"
    "Content-Type"  = "application/json"
  }
  $resp = Invoke-RestMethod -Uri $targetEndpoint -Method Post -Headers $headers -Body $payload -TimeoutSec 5
  Write-Host "[SUCCESS] Enqueued via Pennant Daemon: QueueID $($resp.queueId)" -ForegroundColor Green
  return $resp
} catch {
  Write-Warning "[-] Pennant daemon call failed: $_"
  $scriptPath = Join-Path $PSScriptRoot "..\Publish-FleetBroadcast.ps1"
  if (Test-Path $scriptPath) {
    & $scriptPath -Account $ProfileId -Message $Message -Url $Url -Targets ($Targets -join ",")
  } else {
    Write-Error "Could not reach Pennant daemon and Publish-FleetBroadcast.ps1 fallback not found."
  }
}
