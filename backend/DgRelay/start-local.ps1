$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$envPath = Join-Path $taskRoot '.env.local'

# Prefer the IPv4 address on the active LAN adapter.  A WSL/Hyper-V adapter
# can appear first in Get-NetIPAddress, but it is not reachable by other LAN
# devices and must not be published as the relay address.
$lanAddress = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
    Select-Object -First 1 -ExpandProperty IPv4Address |
    Select-Object -First 1 -ExpandProperty IPAddress
if (-not $lanAddress) {
    $lanAddress = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.IPAddress -notlike '169.254*' -and
            $_.InterfaceAlias -notmatch 'WSL|Hyper-V|vEthernet|Virtual|Loopback'
        } |
        Select-Object -First 1 -ExpandProperty IPAddress
}
if (-not $lanAddress) { throw '找不到可供區網使用的 IPv4 位址。' }

# Keep the local frontend and browser-facing relay URL in sync whenever DHCP
# assigns a new address.  The file contains secrets, so never print its
# contents or the resulting values.
$envLines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $envPath)
function Set-EnvLine([string]$name, [string]$value) {
    for ($index = 0; $index -lt $envLines.Count; $index++) {
        if ($envLines[$index] -match "^$name=") {
            $envLines[$index] = "$name=$value"
            return
        }
    }
    $envLines.Add("$name=$value")
}
Set-EnvLine 'DG_RELAY_PUBLIC_URL' "http://${lanAddress}:5091"
Set-EnvLine 'DG_FRONTEND_ORIGIN' "http://localhost:3000,http://${lanAddress}:3000"
[System.IO.File]::WriteAllText($envPath, ($envLines -join [Environment]::NewLine) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

foreach ($taskLine in $envLines) {
    if ($taskLine -match '^(DG_RELAY_API_KEY|DG_BACKEND_USERNAME|DG_BACKEND_PASSWORD|MT_BACKEND_USERNAME|MT_BACKEND_PASSWORD|DG_FRONTEND_ORIGIN)=(.+)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"', "'"), 'Process')
    }
}
if (-not $env:DG_RELAY_API_KEY) { throw 'Missing server-only DG_RELAY_API_KEY in .env.local' }
Write-Host "LAN relay address updated for $lanAddress (port 5091)."
dotnet run --project (Join-Path $PSScriptRoot 'DgRelay.csproj')
