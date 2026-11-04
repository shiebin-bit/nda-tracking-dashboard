[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path $projectRoot 'backups'
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$fileName = 'nda-database-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dump'
$backupPath = Join-Path $backupRoot $fileName
$containerPath = '/tmp/' + [Guid]::NewGuid().ToString('N') + '.dump'

Push-Location $projectRoot
try {
    & docker compose exec -T db pg_dump -U nda_app -d nda_tracker --format=custom "--file=$containerPath"
    if ($LASTEXITCODE -ne 0) { throw 'Database backup failed.' }
    & docker compose cp "db:$containerPath" $backupPath
    if ($LASTEXITCODE -ne 0) { throw 'Database backup could not be copied to the computer.' }
    & docker compose exec -T db rm -- $containerPath
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Backup is saved; its temporary container copy could not be removed.' }
    Write-Host "Database backup saved: $backupPath"
} finally {
    Pop-Location
}
