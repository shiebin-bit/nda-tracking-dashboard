[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dashboardUrl = 'http://127.0.0.1:5183'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop is required. Install and open Docker Desktop, then try again.'
}
& docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker is not ready. Open Docker Desktop and wait for the engine to start.'
}

$envPath = Join-Path $projectRoot '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    $randomBytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
    $databasePassword = ([BitConverter]::ToString($randomBytes)).Replace('-', '').ToLowerInvariant()
    [IO.File]::WriteAllText($envPath, "NDA_DB_PASSWORD=$databasePassword`n", (New-Object Text.UTF8Encoding($false)))
    $databasePassword = $null
    Write-Host 'Created local database configuration.'
}

Push-Location $projectRoot
try {
    & docker compose up -d --build --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'The dashboard could not start. Review the Docker output above.' }
    Write-Host "Dashboard ready: $dashboardUrl"
    if (-not $NoBrowser) { Start-Process $dashboardUrl }
} finally {
    Pop-Location
}
