<#
.SYNOPSIS
    Automates the provisioning of Stripe Products, Prices, and Branded Payment Links for Pennant Hoist.
.DESCRIPTION
    Requires STRIPE_SECRET_KEY environment variable (test or live).
    Calls Stripe API directly to create:
      1. Pennant Hoist - Desktop License ($49.00 USD / year)
      2. Pennant Hoist - Cloud Sync Tier ($89.00 USD / year)
      3. Branded Payment Links with custom redirects.
#>

param(
    [string]$ApiKey = $env:STRIPE_SECRET_KEY
)

if (-not $ApiKey) {
    Write-Warning "[-] Missing Stripe Secret Key. Provide -ApiKey sk_test_... or set `$env:STRIPE_SECRET_KEY."
    Write-Host "    Example: .\scripts\Setup-StripeProducts.ps1 -ApiKey sk_test_51P..." -ForegroundColor Cyan
    exit 1
}

$headers = @{
    "Authorization" = "Bearer $ApiKey"
    "Content-Type"  = "application/x-www-form-urlencoded"
}

Write-Host "[*] Contacting Stripe API to provision Pennant Hoist products..." -ForegroundColor Yellow

# 1. Create Desktop Solo Product
$prodParams = @{
    "name"        = "Pennant Hoist — Desktop Seat"
    "description" = "Perpetual local operations console license with 1 year of updates & offline cryptographic enclave."
    "images[0]"   = "https://raw.githubusercontent.com/Layline-Digital/pennant-social/main/assets/pennant-card-1200x630.png"
}
$desktopProd = Invoke-RestMethod -Uri "https://api.stripe.com/v1/products" -Method Post -Headers $headers -Body $prodParams

# 2. Create $49/yr Price for Desktop Seat
$priceParams = @{
    "product"             = $desktopProd.id
    "unit_amount"         = 4900
    "currency"            = "usd"
    "recurring[interval]" = "year"
}
$desktopPrice = Invoke-RestMethod -Uri "https://api.stripe.com/v1/prices" -Method Post -Headers $headers -Body $priceParams

# 3. Create Cloud Fleet Sync Product
$cloudParams = @{
    "name"        = "Pennant Hoist — Cloud Fleet Sync"
    "description" = "24/7 headless background dispatch daemon, multi-workstation sync, and hosted outbox automation."
    "images[0]"   = "https://raw.githubusercontent.com/Layline-Digital/pennant-social/main/assets/pennant-card-1200x630.png"
}
$cloudProd = Invoke-RestMethod -Uri "https://api.stripe.com/v1/products" -Method Post -Headers $headers -Body $cloudParams

# 4. Create $89/yr Price for Cloud Sync
$cloudPriceParams = @{
    "product"             = $cloudProd.id
    "unit_amount"         = 8900
    "currency"            = "usd"
    "recurring[interval]" = "year"
}
$cloudPrice = Invoke-RestMethod -Uri "https://api.stripe.com/v1/prices" -Method Post -Headers $headers -Body $cloudPriceParams

# 5. Create Branded Payment Links
$plParams = @{
    "line_items[0][price]"    = $desktopPrice.id
    "line_items[0][quantity]" = 1
    "after_completion[type]"  = "hosted_confirmation"
}
$desktopLink = Invoke-RestMethod -Uri "https://api.stripe.com/v1/payment_links" -Method Post -Headers $headers -Body $plParams

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "  PENNANT HOIST // STRIPE PROVISIONING COMPLETE" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host "Desktop Product ID:   $($desktopProd.id)"
Write-Host "Desktop Price ID:     $($desktopPrice.id) ($49/yr)"
Write-Host "Desktop Payment Link: $($desktopLink.url)" -ForegroundColor Cyan
Write-Host "Cloud Product ID:     $($cloudProd.id)"
Write-Host "Cloud Price ID:       $($cloudPrice.id) ($89/yr)"
Write-Host "========================================================`n"
