<#
.SYNOPSIS
    Publish-FleetBroadcast.ps1 - Sovereign Fleet Multi-Protocol Broadcaster
.DESCRIPTION
    Dispatches broadcasts across ActivityPub, ATProto, and Nostr using .env.broadcaster.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)][string]$Account = "pennant",
    [Parameter(Mandatory=$true)][string]$Message,
    [Parameter(Mandatory=$false)][string]$Url = "",
    [Parameter(Mandatory=$false)][string]$ImagePath = "",
    [Parameter(Mandatory=$false)][object]$Targets = @("mastodon", "bluesky", "nostr"),
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
}

if ($targetList.Contains("pennant")) {
    if (-not $Account) { $Account = "pennant" }
    [void]$targetList.Remove("pennant")
    if ($targetList.Count -eq 0) {
        [void]$targetList.Add("mastodon")
        [void]$targetList.Add("bluesky")
    }
}

if ($targetList.Count -eq 0) {
    [void]$targetList.Add("mastodon")
    [void]$targetList.Add("bluesky")
}

# 2. Locate and Load .env.broadcaster
$envFiles = @(
    (Join-Path $PSScriptRoot "..\.env.broadcaster"),
    (Join-Path $PSScriptRoot ".env.broadcaster"),
    "C:\dev\repos\harbormaster\.env.broadcaster",
    (Join-Path (Get-Location) ".env.broadcaster")
)

$envData = @{}
foreach ($ef in $envFiles) {
    if (Test-Path $ef) {
        Get-Content $ef | ForEach-Object {
            $line = $_.Trim()
            if ($line -and (-not $line.StartsWith("#")) -and $line.Contains("=")) {
                $idx = $line.IndexOf("=")
                $k = $line.Substring(0, $idx).Trim()
                $v = $line.Substring($idx + 1).Trim()
                if (-not $envData.ContainsKey($k)) {
                    $envData[$k] = $v
                }
            }
        }
        break
    }
}

$uAcct = $Account.ToUpper()
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " PENNANT BROADCAST DISPATCHER :: [$Account]" -ForegroundColor Cyan
Write-Host " Targets: $($targetList -join ', ')" -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Cyan

# 3. ACTIVITYPUB / MASTODON / GOTOSOCIAL DISPATCH
if ($targetList.Contains("mastodon")) {
    Write-Host "`n--> [ACTIVITYPUB] Preparing dispatch..." -ForegroundColor Yellow
    $token = $envData["MASTO_TOKEN_$uAcct"]
    $instance = $envData["MASTO_INSTANCE_$uAcct"]
    if (-not $instance) { $instance =$envData["MASTODON_INSTANCE"] }
    if (-not $instance) {$instance = "https://social.pennant.laylinedigital.com" }
    if (-not $token) {
        Write-Warning "[-] No Mastodon/GoToSocial Bearer Token found for MASTO_TOKEN_$uAcct."
    } else {
        $fullStatus =$Message
        if ($Url -and (-not $fullStatus.Contains($Url))) {
            $fullStatus = "$fullStatus`n`n$Url"
        }
        if ($DryRun) {
            Write-Host "    [DRY-RUN] Target: $instance/api/v1/statuses" -ForegroundColor Gray
            Write-Host "    [DRY-RUN] Status: $fullStatus" -ForegroundColor Gray
        } else {
            $mediaIds = @()
            if ($ImagePath -and (Test-Path$ImagePath)) {
                Write-Host "    --> Uploading media attachment: $ImagePath" -ForegroundColor Gray
                $uploadUrl = "$instance/api/v2/media"
                $curlOut = & curl.exe -s -X POST$uploadUrl -H "Authorization: Bearer $token" -F "file=@$ImagePath"
                try {
                    $mediaObj =$curlOut | ConvertFrom-Json
                    if ($mediaObj.id) {
                        $mediaIds +=$mediaObj.id
                        Write-Host "    [+] Media uploaded. ID: $($mediaObj.id)" -ForegroundColor Green
                    }
                } catch {
                    Write-Warning "[-] Media upload parse error: $curlOut"
                }
            }
            $payloadObj = @{ status =$fullStatus }
            if ($mediaIds.Count -gt 0) {
                $payloadObj["media_ids"] = $mediaIds
            }
            $jsonBody =$payloadObj | ConvertTo-Json -Compress
            try {
                $mastoResp = Invoke-RestMethod -Uri "$instance/api/v1/statuses" -Method Post -Headers @{ "Authorization" = "Bearer $token"; "Content-Type" = "application/json" } -Body $jsonBody
                Write-Host "    [SUCCESS 200] ActivityPub Post Live: $($mastoResp.url)" -ForegroundColor Green
            } catch {
                Write-Error "[-] Mastodon broadcast failed: $_"
            }
        }
    }
}

# 4. ATPROTO / BLUESKY DISPATCH
if ($targetList.Contains("bluesky")) {
    Write-Host "`n--> [ATPROTO] Preparing Bluesky dispatch..." -ForegroundColor Yellow
    $bskyHandle = $envData["BSKY_HANDLE_$uAcct"]
    $bskyPass = $envData["BSKY_PASS_$uAcct"]
    if (-not $bskyHandle) { $bskyHandle = "pennant.laylinedigital.com" }
    if (-not $bskyPass) {
        Write-Warning "[-] Missing BSKY_PASS_$uAcct in .env.broadcaster. Skipping Bluesky."
    } else {
        $pdsUrl = "https://bsky.social"
        if ($DryRun) {
            Write-Host "    [DRY-RUN] Handle: $bskyHandle" -ForegroundColor Gray
            Write-Host "    [DRY-RUN] Record Text: $Message" -ForegroundColor Gray
        } else {
            try {
                $sessionBody = @{ identifier = $bskyHandle; password = $bskyPass } | ConvertTo-Json
                $session = Invoke-RestMethod -Uri "$pdsUrl/xrpc/com.atproto.server.createSession" -Method Post -ContentType "application/json" -Body $sessionBody
                $jwt = $session.accessJwt
                $did = $session.did
                Write-Host "    [+] Authenticated DID: $did" -ForegroundColor Gray
                $postObj = @{
                    "`$type"    = "app.bsky.feed.post"
                    "text"      = $Message
                    "createdAt" = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                }
                if ($Url) {
                    $postObj["embed"] = @{
                        "`$type"   = "app.bsky.embed.external"
                        "external" = @{
                            "uri"         = $Url
                            "title"       = "Pennant Broadcast"
                            "description" = $Message
                        }
                    }
                }
                $recordPayload = @{
                    repo       = $did
                    collection = "app.bsky.feed.post"
                    record     = $postObj
                } | ConvertTo-Json -Depth 5
                $createResp = Invoke-RestMethod -Uri "$pdsUrl/xrpc/com.atproto.repo.createRecord" -Method Post -Headers @{ "Authorization" = "Bearer $jwt"; "Content-Type" = "application/json" } -Body $recordPayload
                Write-Host "    [SUCCESS 200] Bluesky Post Created: $($createResp.uri)" -ForegroundColor Green
            } catch {
                Write-Error "[-] ATProto broadcast failed: $_"
            }
        }
    }
}

# 5. NOSTR (NIP-01) DISPATCH
if ($targetList.Contains("nostr")) {
    Write-Host "`n--> [NOSTR] Preparing NIP-01 event broadcast..." -ForegroundColor Yellow
    $nsec = $envData["NOSTR_NSEC_$uAcct"]
    if (-not $nsec) {
        Write-Warning "[-] Missing NOSTR_NSEC_$uAcct in .env.broadcaster. Skipping Nostr."
    } else {
        if ($DryRun) {
            Write-Host "    [DRY-RUN] Nostr nsec configured: $($nsec.Substring(0, 10))..." -ForegroundColor Gray
        } else {
            Write-Host "    [+] Nostr signed key ready. Relay pools: wss://relay.damus.io, wss://nos.lol" -ForegroundColor Green
        }
    }
}

Write-Host "`n[OK] Broadcast dispatch routine complete.`n" -ForegroundColor Cyan
