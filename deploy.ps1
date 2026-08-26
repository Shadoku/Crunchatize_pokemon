# Builds this stage and uploads it to chub.ai, without relying on GitHub
# Actions - useful when the CI runner's IP gets caught by chub.ai's regional
# API block ("This service is not available in your country."), since a
# normal residential/office connection generally isn't.
#
# Run this via deploy.bat (double-click it, or `deploy.bat` from a shell).
# Requires: Node 21.7.1 + Yarn on PATH, and curl.exe (ships with Windows 10+).
#
# Auth: set a CHUB_AUTH_TOKEN environment variable, or just run the script -
# it will prompt for the token and offer to remember it in chub_auth_token.txt
# (already .gitignore'd - never commit that file).
# Get a token from https://chub.ai/my_stages?active=tokens

param(
    [string]$Token = $env:CHUB_AUTH_TOKEN
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$metaPath = Join-Path $root 'public\chub_meta.yaml'
$tokenFile = Join-Path $root 'chub_auth_token.txt'

function Fail($message) {
    Write-Host "`nERROR: $message" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $root 'package.json'))) {
    Fail "package.json not found next to this script - is it still in the repo root?"
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    Fail "curl.exe not found on PATH. It ships with Windows 10 (1803+) and Windows 11 by default."
}
if (-not (Get-Command yarn -ErrorAction SilentlyContinue)) {
    Fail "yarn not found on PATH. Install Node 21.7.1, then run: npm install -g yarn"
}

# --- Resolve auth token ---
if (-not $Token -and (Test-Path $tokenFile)) {
    $Token = (Get-Content $tokenFile -Raw).Trim()
}
if (-not $Token) {
    $Token = Read-Host -Prompt 'Paste your chub.ai auth token (from https://chub.ai/my_stages?active=tokens)'
    if ($Token) {
        $save = Read-Host -Prompt 'Save it to chub_auth_token.txt for next time? (y/N)'
        if ($save -match '^[Yy]') {
            Set-Content -Path $tokenFile -Value $Token -NoNewline
            Write-Host "Saved to $tokenFile"
        }
    }
}
if (-not $Token) {
    Fail "No CHUB_AUTH_TOKEN provided."
}

# --- Ensure github_path is set, same as the GitHub Actions workflow does ---
$metaContent = Get-Content $metaPath -Raw
if ($metaContent -notmatch '(?m)^github_path:') {
    $repoUrl = 'https://github.com/Shadoku/Crunchatize_pokemon'
    Add-Content -Path $metaPath -Value "`ngithub_path: '$repoUrl'`n"
    Write-Host "Wrote github_path to chub_meta.yaml - remember to commit this."
    $metaContent = Get-Content $metaPath -Raw
}

# --- Resolve or create extension_id ---
$stageId = $null
if ($metaContent -match "(?m)^extension_id:\s*['""]([^'""]+)['""]") {
    $stageId = $Matches[1]
    Write-Host "Using existing extension_id: $stageId"
} else {
    Write-Host "No extension_id found in chub_meta.yaml; asking chub.ai to create a new stage..."
    $projectName = Split-Path -Leaf $root
    $creationJson = Join-Path $root 'creation.json'
    $body = (@{ name = $projectName } | ConvertTo-Json -Compress)
    # Also routed through the relay, same as the upload step below. The relay's
    # only confirmed route is /{id}/ (proxying to /extension/{id}/upload), so
    # hitting it at the bare root for "create a new extension" (no id yet,
    # mirroring POST /extensions) is an unverified guess at a symmetric route -
    # if this 404s, the relay likely doesn't proxy creation and this needs to
    # go directly to https://api.chub.ai/extensions (or /api/extensions) instead.
    $status = & curl.exe -s -o $creationJson -w "%{http_code}" `
        -H "CH-API-KEY: $Token" -H "Content-Type: application/json" `
        --request POST --data $body https://chub-relay.jake-h.workers.dev/

    $created = $null
    try { $created = Get-Content $creationJson -Raw | ConvertFrom-Json } catch { $created = $null }

    if (-not $created -or -not $created.id_v2) {
        Write-Host "HTTP status: $status"
        Write-Host "Response: $(Get-Content $creationJson -Raw)"
        Fail "Could not create a new extension on chub.ai. If the response above says something like 'This service is not available in your country', chub.ai is geo-blocking this connection too - try a different network/VPN. Otherwise, check that CHUB_AUTH_TOKEN is valid."
    }

    $stageId = $created.id_v2
    Add-Content -Path $metaPath -Value "`nextension_id: '$stageId'`n"
    Write-Host "Created extension_id: $stageId (written to chub_meta.yaml - remember to commit this!)"
}

# --- Install deps + build ---
Write-Host "`n==> yarn install"
& yarn install
if ($LASTEXITCODE -ne 0) { Fail "yarn install failed." }

Write-Host "`n==> yarn build"
& yarn build
if ($LASTEXITCODE -ne 0) { Fail "yarn build failed." }

# --- Zip dist/ (contents at the zip root, matching the GitHub Actions build) ---
$distPath = Join-Path $root 'dist'
$zipPath = Join-Path $root 'build.zip'
if (-not (Test-Path $distPath)) {
    Fail "dist/ folder not found after build."
}
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Write-Host "`n==> Zipping dist/ -> build.zip"
Compress-Archive -Path (Join-Path $distPath '*') -DestinationPath $zipPath -Force

# --- Upload ---
# Routed through a third-party relay (not chub.ai directly), same as
# deploy.yml, as a workaround for chub.ai/Cloudflare rejecting GitHub-runner
# and VPN IPs outright. The relay operator can see the auth token and the
# build - drop back to https://api.chub.ai/extension/$stageId/upload directly
# if that trust tradeoff stops being acceptable.
$uploadUrl = "https://chub-relay.jake-h.workers.dev/$stageId/"
Write-Host "`n==> Uploading to $uploadUrl"
$uploadResponseJson = Join-Path $root 'upload_response.json'
$status = & curl.exe -s -o $uploadResponseJson -w "%{http_code}" `
    -H "CH-API-KEY: $Token" -F "file=@$zipPath" `
    $uploadUrl

$responseBody = Get-Content $uploadResponseJson -Raw
Write-Host "HTTP status: $status"
Write-Host "Response: $responseBody"

if ([int]$status -lt 200 -or [int]$status -ge 300) {
    Fail "Upload failed with HTTP status $status."
}

$parsed = $null
try { $parsed = $responseBody | ConvertFrom-Json } catch { $parsed = $null }
if (-not $parsed) {
    Fail "chub.ai did not return a valid JSON response, which usually means the upload didn't actually go through (e.g. chub.ai's regional API block returns a plain error string like 'This service is not available in your country.'). See the response above."
}

Write-Host "`nUpload succeeded!" -ForegroundColor Green
if ($metaContent -notmatch "(?m)^extension_id:") {
    Write-Host "Don't forget: git add public/chub_meta.yaml and commit the new extension_id/github_path." -ForegroundColor Yellow
}
