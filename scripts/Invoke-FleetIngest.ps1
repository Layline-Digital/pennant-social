<#
.SYNOPSIS
    Invoke-FleetIngest.ps1 - Downstream Fleet Ingestion Dispatcher
.DESCRIPTION
    Dispatches broadcasts from downstream fleet apps (The Sailing Almanac, Postmodern Cereal)
    to the Pennant broadcast daemon via HTTP POST /api/ingest/fleet, or falls back to
    Publish-FleetBroadcast.ps1 directly if the daemon is offline.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)][ValidateSet("sailing-almanac", "postmodern-cereal", "fleet-worker")][string]$Source = "fleet-worker",
    [Parameter(Mandatory=$false)][string]$ProfileId = "pennant",
    [Parameter(Mandatory=$true)][string]$Message,
    [Parameter(Mandatory=$false)][string]$Url = "",
    [Parameter(Mandatory=$false)][object]$Targets = @("mastodon", "bluesky", "nostr"),
    [Parameter(Mandatory=$false)][string]$ScheduledFor = "",
    [Parameter(Mandatory=$false)][string]$ApiKey = "",
    [switch]$DryRun
)

# 1. Normalize Target Networks into String Array
$targetList = [System.Collections.Generic.List[string]]::new()
if ($Targets -is [string]) {
    foreach ($item in $Targets.Split(",")) {
        $clean = $item.Trim().ToLower()
        if ($clean) { [void]$targetList.Add($clean) }
    }
} elseif ($Targets -is [System.Collections.IEnumerable]) {
    foreach ($item in $Targets) {
        if ($item -is [string]) {
            foreach ($sub in $item.Split(",")) {
                $clean = $sub.Trim().ToLower()
                if ($clean) { [void]$targetList.Add($clean) }
            }
        }
    }
} else {
    [void]$targetList.Add("mastodon")
    [void]$targetList.Add("bluesky")
    [void]$targetList.Add("nostr")
}

if ($targetList.Count -eq 0) {
    [void]$targetList.Add("mastodon")
    [void]$targetList.Add("bluesky")
    [void]$targetList.Add("nostr")
}

# 2. Locate ApiKey if not explicitly supplied
if (-not $ApiKey) {
    $ApiKey = $env:PENNANT_FLEET_INGEST_KEY
}

if (-not $ApiKey) {
    $envFiles = @(
        (Join-Path $PSScriptRoot "..\.env.broadcaster"),
        (Join-Path $PSScriptRoot ".env.broadcaster"),
        "C:\dev\repos\harbormaster\.env.broadcaster",
        (Join-Path (Get-Location) ".env.broadcaster")
    )
    foreach ($ef in $envFiles) {
        if (Test-Path $ef) {
            Get-Content $ef | ForEach-Object {
                $line = $_.Trim()
                if ($line -and (-not $line.StartsWith("#")) -and $line.Contains("=")) {
                    $idx = $line.IndexOf("=")
                    $k = $line.Substring(0, $idx).Trim()
                    $v = $line.Substring($idx + 1).Trim()
                    if ($k -eq "PENNANT_FLEET_INGEST_KEY" -and -not $ApiKey) {
                        $ApiKey = $v
                    }
                }
            }
            if ($ApiKey) { break }
        }
    }
}

# 3. Build JSON payload for HTTP ingestion
$payloadMap = [ordered]@{
    source    = $Source
    profileId = $ProfileId
    message   = $Message
    targets   = @($targetList)
}
if ($Url) {
    $payloadMap["url"] = $Url
}
if ($ScheduledFor) {
    $payloadMap["scheduledFor"] = $ScheduledFor
}
$jsonPayload = $payloadMap | ConvertTo-Json -Compress

# 4. Attempt HTTP Dispatch to Local Pennant Daemon
$port = if ($env:PORT) { $env:PORT } else { "7420" }
$endpoint = "http://127.0.0.1:$port/api/ingest/fleet"

$headers = @{
    "Content-Type" = "application/json"
}
if ($ApiKey) {
    $headers["Authorization"] = "Bearer $ApiKey"
}

$isOffline = $false
try {
    Write-Host "[*] Dispatching fleet ingest to Pennant daemon at $endpoint..." -ForegroundColor Cyan
    $response = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -Body $jsonPayload
    Write-Host "[+] Successfully enqueued broadcast via Pennant daemon!" -ForegroundColor Green
    Write-Host "    Queue ID:      $($response.queueId)" -ForegroundColor Green
    Write-Host "    Status:        $($response.status)" -ForegroundColor Green
    Write-Host "    Scheduled For: $($response.scheduledFor)" -ForegroundColor Green
    return $response
} catch {
    # Check if this error was an active HTTP rejection from the daemon
    # (e.g. 401 Unauthorized or 400 Bad Request) vs connection failure (offline)
    if ($_.Exception -and $_.Exception.Response) {
        $statusCode = [int]$_.Exception.Response.StatusCode
        Write-Error "[-] Pennant daemon rejected broadcast with HTTP $($statusCode): $($_.Exception.Message)"
        throw
    } else {
        $isOffline = $true
    }
}

# 5. Fallback: Direct invocation of Publish-FleetBroadcast.ps1 when daemon is offline
if ($isOffline) {
    Write-Host "[-] Pennant daemon offline at $endpoint. Falling back to direct dispatch via Publish-FleetBroadcast.ps1..." -ForegroundColor Yellow


    $publishScript = @(
        (Join-Path $PSScriptRoot "..\Publish-FleetBroadcast.ps1"),
        (Join-Path $PSScriptRoot "Publish-FleetBroadcast.ps1"),
        (Join-Path (Get-Location) "Publish-FleetBroadcast.ps1")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $publishScript) {
        Write-Error "[-] Could not find Publish-FleetBroadcast.ps1 in repository tree."
        return
    }

    $callParams = @{
        Account = $ProfileId
        Message = $Message
        Targets = @($targetList)
    }
    if ($Url) {
        $callParams["Url"] = $Url
    }
    if ($DryRun) {
        $callParams["DryRun"] = $true
    }

    & $publishScript @callParams
}
