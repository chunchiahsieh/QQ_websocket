$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
foreach ($taskLine in (Get-Content -LiteralPath (Join-Path $taskRoot '.env.local'))) {
    if ($taskLine -match '^(DG_RELAY_API_KEY|DG_BACKEND_USERNAME|DG_BACKEND_PASSWORD|MT_BACKEND_USERNAME|MT_BACKEND_PASSWORD)=(.+)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"', "'"), 'Process')
    }
}
if (-not $env:DG_RELAY_API_KEY) { throw 'Missing server-only DG_RELAY_API_KEY in .env.local' }
dotnet run --project (Join-Path $PSScriptRoot 'DgRelay.csproj')
