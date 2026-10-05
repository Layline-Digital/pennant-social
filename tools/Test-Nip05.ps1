function Test-Nip05 {
    [CmdletBinding()]
    param (
        [Parameter(Mandatory = $true)]
        [string]$Domain,

        [Parameter(Mandatory = $false)]
        [string]$Name = "_",

        [Parameter(Mandatory = $false)]
        [string]$ExpectedHexPubkey
    )

    $url = "https://$Domain/.well-known/nostr.json?name=$Name"
    Write-Host "--> Probing NIP-05 endpoint: $url" -ForegroundColor Cyan

    try {
        $bodyRaw = curl.exe -s -L "$url"
        $headersRaw = curl.exe -s -I -L "$url"

        if (-not $bodyRaw) {
            Write-Warning "  [FAIL] Empty response from server."
            return $false
        }

        # Check HTTP Status of final hop
        $statusMatches = [regex]::Matches($headersRaw, 'HTTP/\d+(\.\d+)?\s+(\d+)')
        $statusCode = if ($statusMatches.Count -gt 0) { [int]$statusMatches[$statusMatches.Count - 1].Groups[2].Value } else { 0 }
        Write-Host "  Final HTTP Status: $statusCode" -ForegroundColor $(if ($statusCode -eq 200) { "Green" } else { "Red" })

        # Check CORS
        $corsMatches = [regex]::Matches($headersRaw, '(?i)access-control-allow-origin:\s*(\S+)')
        if ($corsMatches.Count -gt 0) {
            $corsVal = $corsMatches[$corsMatches.Count - 1].Groups[1].Value.Trim()
            if ($corsVal -eq "*") {
                Write-Host "  [OK] CORS Header present: Access-Control-Allow-Origin: *" -ForegroundColor Green
            } else {
                Write-Warning "  [WARN] CORS present but not '*': $corsVal"
            }
        } else {
            Write-Warning "  [WARN] Missing Access-Control-Allow-Origin header."
        }

        $json = $bodyRaw | ConvertFrom-Json
        if ($json.names -and $json.names.PSObject.Properties[$Name]) {
            $foundPubkey = $json.names.$Name
            Write-Host "  [OK] Found pubkey for '$Name': $foundPubkey" -ForegroundColor Green

            if ($ExpectedHexPubkey) {
                if ($foundPubkey.ToLower() -eq $ExpectedHexPubkey.ToLower()) {
                    Write-Host "  [MATCH] Public key matches expected hex key." -ForegroundColor Green
                    return $true
                } else {
                    Write-Warning "  [MISMATCH] Found $foundPubkey, expected $ExpectedHexPubkey"
                    return $false
                }
            }
            return $true
        } else {
            Write-Warning "  [FAIL] JSON returned but name '$Name' was not found in 'names' dictionary."
            return $false
        }
    } catch {
        Write-Warning "  [FAIL] Verification error: $($_.Exception.Message)"
        return $false
    }
}
