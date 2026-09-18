$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
foreach ($taskLine in (Get-Content -LiteralPath (Join-Path $taskRoot '.env.local'))) {
    if ($taskLine -match '^(DG_RELAY_API_KEY|DG_BACKEND_USERNAME|DG_BACKEND_PASSWORD|MT_BACKEND_USERNAME|MT_BACKEND_PASSWORD|DG_FRONTEND_ORIGIN)=(.+)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"', "'"), 'Process')
    }
}
if (-not $env:DG_RELAY_API_KEY) { throw 'Missing server-only DG_RELAY_API_KEY in .env.local' }
if (-not $env:DG_FRONTEND_ORIGIN) {
    $lanAddress = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' -and $_.PrefixLength -ge 16 } |
        Select-Object -First 1 -ExpandProperty IPAddress
    $origins = @('http://localhost:3000')
    if ($lanAddress) { $origins += "http://${lanAddress}:3000" }
    $env:DG_FRONTEND_ORIGIN = $origins -join ','
}
dotnet run --project (Join-Path $PSScriptRoot 'DgRelay.csproj')
