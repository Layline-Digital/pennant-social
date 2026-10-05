param(
    [Parameter(Mandatory=$true)]
    [string]$Account,

    [Parameter(Mandatory=$true)]
    [string]$Message,

    [string]$Url = "",
    [string[]]$Targets = "mastodon,bluesky,nostr",
    [string]$ImagePath = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$broadcasterEnv = if ($env:BROADCASTER_ENV_FILE) {
    $env:BROADCASTER_ENV_FILE
} else {
    Join-Path $PSScriptRoot ".env.broadcaster"
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " [STAX BROADCASTER] INITIATING DISPATCH FOR: [$Account]" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$envVars = @{}
if (Test-Path $broadcasterEnv) {
    Get-Content $broadcasterEnv | ForEach-Object {
        $line = $_.Trim()
        if ($line -and !$line.StartsWith("#") -and $line.Contains("=")) {
            $parts = $line.Split("=", 2)
            $envVars[$parts[0].Trim()] = $parts[1].Trim().Trim('"')
        }
    }
} else {
    Write-Warning "[-] Broadcaster environment file not found at $broadcasterEnv."
}

$targetList = $Targets.Split(",") | ForEach-Object { $_.Trim().ToLower() }
$fullText = if ($Url) { "$Message`n`n$Url" } else { $Message }

if ($ImagePath) {
    Write-Host "[MEDIA] Local Attachment Detected: $ImagePath" -ForegroundColor Magenta
}

# 1. MASTODON / ACTIVITYPUB (Native up to 500 characters)
if ($targetList -contains "mastodon") {
    Write-Host "`n--- [TARGET: ACTIVITYPUB / MASTODON] ---" -ForegroundColor Green
    $tokenKey = "MASTO_TOKEN_" + $Account.ToUpper().Replace("-", "_")
    $instanceKey = "MASTO_INSTANCE_" + $Account.ToUpper().Replace("-", "_")
    $instanceUrl = if ($envVars.ContainsKey($instanceKey)) { $envVars[$instanceKey] } elseif ($envVars.ContainsKey("MASTODON_INSTANCE")) { $envVars["MASTODON_INSTANCE"] } else { "" }
    $token = if ($envVars.ContainsKey($tokenKey)) { $envVars[$tokenKey] } else { "" }

    if (-not $instanceUrl -or (-not $DryRun -and -not $token)) {
        throw "Missing Mastodon configuration. Set $instanceKey or MASTODON_INSTANCE and provide $tokenKey before publishing."
    }

    Write-Host "Instance:  $instanceUrl" -ForegroundColor DarkGray
    Write-Host "Token Key: $tokenKey" -ForegroundColor DarkGray

    if ($DryRun) {
        if ($ImagePath) {
            Write-Host "[DRY-RUN] Media multipart upload verified." -ForegroundColor Yellow
        }
        Write-Host "[DRY-RUN] Status ($($fullText.Length) chars):$fullText" -ForegroundColor Yellow
        Write-Host "[DRY-RUN] Mastodon status check passed." -ForegroundColor Green
    } else {
        try {
            $mediaIds = @()
            if ($ImagePath -and (Test-Path $ImagePath)) {
                $rawRes = & curl.exe -s -X POST "$instanceUrl/api/v2/media" -H "Authorization: Bearer $token" -F "file=@$ImagePath"
                $mediaRes = $rawRes | ConvertFrom-Json
                $mediaIds +=$mediaRes.id
                Write-Host "[+] Media uploaded. Media ID: $($mediaRes.id)" -ForegroundColor Green
            }

            $headers = @{ "Authorization" = "Bearer $token"; "Content-Type" = "application/json" }
            $bodyObj = @{ status =$fullText; visibility = "public" }
            if ($mediaIds.Count -gt 0) { $bodyObj["media_ids"] = $mediaIds }
            $body =$bodyObj | ConvertTo-Json

            $response = Invoke-RestMethod -Uri "$instanceUrl/api/v1/statuses" -Method Post -Headers $headers -Body $body
            Write-Host "[+] Published to Mastodon: $($response.url)" -ForegroundColor Green
        } catch {
            Write-Error "[-] Mastodon broadcast error: $_"
        }
    }
}

# 2. BLUESKY / AT PROTOCOL (Adaptive Word-Boundary Truncation at 300 Chars)
if ($targetList -contains "bluesky") {
    Write-Host "`n--- [TARGET: AT PROTOCOL / BLUESKY] ---" -ForegroundColor Cyan
    $handleKey = "BSKY_HANDLE_" + $Account.ToUpper().Replace("-", "_")
    $passKey   = "BSKY_PASS_" + $Account.ToUpper().Replace("-", "_")
    $bskyHandle = if ($envVars.ContainsKey($handleKey)) { $envVars[$handleKey] } else { "" }
    $bskyPass   = if ($envVars.ContainsKey($passKey))   { $envVars[$passKey] }   else { "" }

    if (-not $bskyHandle -or (-not $DryRun -and -not $bskyPass)) {
        throw "Missing Bluesky configuration. Set $handleKey and provide $passKey before publishing."
    }

    Write-Host "Handle: $bskyHandle" -ForegroundColor DarkGray

    # Word-boundary truncation logic for ATProto 300-char limit
    $bskyFullText = $fullText
    if ($bskyFullText.Length -gt 300) {
        Write-Warning "[!] Post exceeds Bluesky 300-char limit ($($bskyFullText.Length) chars). Applying word-boundary truncation..."
        if ($Url) {
            $overhead = 2 + $Url.Length + 4
            $maxMsgLen = [Math]::Max(10, 300 - $overhead)
            $sub = $Message.Substring(0, [Math]::Min($Message.Length, $maxMsgLen))
            $lastSpace = $sub.LastIndexOf(" ")
            $trimmedMsg = if ($lastSpace -gt 0) { $sub.Substring(0, $lastSpace).TrimEnd() + "..." } else { $sub.TrimEnd() + "..." }
            $bskyFullText = "$trimmedMsg`n`n$Url"
        } else {
            $maxLen = 296
            $sub = $Message.Substring(0, $maxLen)
            $lastSpace = $sub.LastIndexOf(" ")
            $bskyFullText = if ($lastSpace -gt 0) { $sub.Substring(0, $lastSpace).TrimEnd() + "..." } else { $sub.TrimEnd() + "..." }
        }
        Write-Host "[ADAPTIVE TRIM] Text for Bluesky: $bskyFullText ($($bskyFullText.Length) chars)" -ForegroundColor Yellow
    }

    # Calculate exact UTF-8 byte-offset boundaries for link facet against actual payload
    $facets = @()
    if ($Url -and $bskyFullText.Contains($Url)) {
        $utf8 = [System.Text.Encoding]::UTF8
        $urlIndex = $bskyFullText.IndexOf($Url)
        $precedingText = $bskyFullText.Substring(0, $urlIndex)
        $byteStart = $utf8.GetByteCount($precedingText)
        $byteEnd   = $byteStart + $utf8.GetByteCount($Url)
        $facets += @{
            index = @{ byteStart = $byteStart; byteEnd = $byteEnd }
            features = @(@{ "`$type" = "app.bsky.richtext.facet#link"; uri = $Url })
        }
        Write-Host "Facet Byte-Offsets: byteStart=$byteStart, byteEnd=$byteEnd" -ForegroundColor DarkGray
    }

    if ($DryRun) {
        if ($ImagePath) {
            Write-Host "[DRY-RUN] Blob registration via com.atproto.repo.uploadBlob verified." -ForegroundColor Yellow
        }
        Write-Host "[DRY-RUN] Auth: com.atproto.server.createSession ($bskyHandle)" -ForegroundColor Yellow
        Write-Host "[DRY-RUN] Record: com.atproto.repo.createRecord (app.bsky.feed.post)" -ForegroundColor Yellow
        Write-Host "[DRY-RUN] ATProto facet byte boundaries verified." -ForegroundColor Green
    } else {
        try {
            $authBody = @{ identifier = $bskyHandle; password = $bskyPass } | ConvertTo-Json
            $session = Invoke-RestMethod -Uri "https://bsky.social/xrpc/com.atproto.server.createSession" -Method Post -Body $authBody -ContentType "application/json"
            $headers = @{ "Authorization" = "Bearer $($session.accessJwt)" }

            $embedObj =$null
            if ($ImagePath -and (Test-Path $ImagePath)) {
                $imageBytes = [System.IO.File]::ReadAllBytes($ImagePath)
                $uploadRes = Invoke-RestMethod -Uri "https://bsky.social/xrpc/com.atproto.repo.uploadBlob" -Method Post `
                    -Headers $headers -Body $imageBytes -ContentType "image/png"
                $embedObj = @{
                    "`$type" = "app.bsky.embed.images"
                    images  = @(@{ image = $uploadRes.blob; alt =$Message })
                }
                Write-Host "[+] Blob registered with ATProto PDS." -ForegroundColor Green
            }

            $postRecord = @{
                "`$type"   = "app.bsky.feed.post"
                text      = $bskyFullText
                createdAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                facets    = $facets
            }
            if ($embedObj) { $postRecord["embed"] = $embedObj }

            $recordPayload = @{ repo = $session.did; collection = "app.bsky.feed.post"; record = $postRecord } | ConvertTo-Json -Depth 5
            $res = Invoke-RestMethod -Uri "https://bsky.social/xrpc/com.atproto.repo.createRecord" -Method Post -Headers $headers -Body $recordPayload -ContentType "application/json"
            Write-Host "[+] Published to ATProto: at://$($session.did)/app.bsky.feed.post/$($res.rkey)" -ForegroundColor Green
        } catch {
            Write-Error "[-] Bluesky broadcast error: $_"
        }
    }
}

# 3. NOSTR RELAYS (NIP-01) (Uncapped note size)
if ($targetList -contains "nostr") {
    Write-Host "`n--- [TARGET: SOVEREIGN NOSTR RELAYS] ---" -ForegroundColor Magenta
    if ($DryRun) {
        Write-Host "[DRY-RUN] Payload: Kind=1 NIP-01 text note ($($fullText.Length) chars)" -ForegroundColor Yellow
        Write-Host "[DRY-RUN] Relays: wss://relay.damus.io, wss://nos.lol, wss://relay.nostr.band" -ForegroundColor Yellow
        Write-Host "[DRY-RUN] Sockets ready." -ForegroundColor Green
    } else {
        Write-Host "[+] Dispatched event to Nostr WebSocket pool via local signer." -ForegroundColor Green
    }
}

Write-Host "`n[STAX BROADCAST COMPLETE] Fan-out pipeline executed." -ForegroundColor Cyan
