# Starts only the local Python collector. Secrets are decrypted in process
# memory from the existing Windows collector's DPAPI-protected settings.
$ErrorActionPreference = 'Stop'
$settingsPath = Join-Path $env:LOCALAPPDATA 'JshenCollector\settings.json'
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $settingsPath)) { throw 'Existing C# collector settings not found.' }
if (-not (Test-Path -LiteralPath $python)) { throw 'Python venv not found; install requirements.txt first.' }
Add-Type -AssemblyName System.Security
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
function Unprotect-CollectorField([string]$ciphertext) {
    $bytes = [Convert]::FromBase64String($ciphertext)
    [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect(
        $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
}
try {
    $env:TZ_USERNAME = Unprotect-CollectorField $settings.Username
    $env:TZ_PASSWORD = Unprotect-CollectorField $settings.Password
    $env:TZ_DEVICE_ID = $settings.DeviceId
    $env:TZ_OFFICIAL_URL = $settings.OfficialUrl
    $env:COLLECTOR_INGEST_KEY = Unprotect-CollectorField $settings.IngestKey
    $env:COLLECTOR_DESTINATIONS = '["https://jason-mt.onrender.com"]'
    & $python (Join-Path $PSScriptRoot 'collector.py')
}
finally {
    Remove-Item Env:TZ_USERNAME, Env:TZ_PASSWORD, Env:TZ_DEVICE_ID, Env:TZ_OFFICIAL_URL, Env:COLLECTOR_INGEST_KEY, Env:COLLECTOR_DESTINATIONS -ErrorAction SilentlyContinue
}
