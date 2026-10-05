function Test-AtprotoDns {
    <#
    .SYNOPSIS
        Validates ATProto custom domain DNS TXT resolution.
    .EXAMPLE
        Test-AtprotoDns -Domain "example.com"
    #>
    [CmdletBinding()]
    param (
        [Parameter(Mandatory = $true)]
        [string]$Domain,

        [Parameter(Mandatory = $false)]
        [string]$ExpectedDid
    )

    $recordName = "_atproto.$Domain"
    Write-Host "--> Resolving DNS TXT for $recordName..." -ForegroundColor Cyan

    try {
        $txtRecords = Resolve-DnsName -Name $recordName -Type TXT -ErrorAction Stop
        $didValues = $txtRecords | ForEach-Object { $_.Strings } | Where-Object { $_ -match "^did=" }

        if (-not $didValues) {
            Write-Warning "[FAIL] Record exists but no 'did=' prefix found."
            return $false
        }

        foreach ($entry in $didValues) {
            $extractedDid = $entry -replace '^did=', ''
            Write-Host "  [OK] Found DID: $extractedDid" -ForegroundColor Green

            if ($ExpectedDid) {
                if ($extractedDid -eq $ExpectedDid) {
                    Write-Host "  [MATCH] Verified against expected DID: $ExpectedDid" -ForegroundColor Green
                    return $true
                } else {
                    Write-Warning "  [MISMATCH] Found $extractedDid, expected $ExpectedDid"
                    return $false
                }
            }
        }
        return $true
    } catch {
        Write-Warning "[FAIL] DNS query failed: $($_.Exception.Message)"
        return $false
    }
}
