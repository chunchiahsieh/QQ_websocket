$ErrorActionPreference = 'Stop'
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$env:ADMIN_URLS = 'http://127.0.0.1:5092'
if (-not $env:ADMIN_DATA_DIR) { $env:ADMIN_DATA_DIR = Join-Path $env:LOCALAPPDATA 'TableAccountAdmin' }
if (-not (Test-Path -LiteralPath (Join-Path $env:ADMIN_DATA_DIR 'accounts.json'))) {
    $env:ADMIN_BOOTSTRAP_USER = Read-Host '首次建立的管理員帳號（3–64 位英數字）'
    $adminSecurePassword = Read-Host '管理員密碼（至少 4 字元；正式環境建議使用長密碼）' -AsSecureString
    $adminCredential = [System.Net.NetworkCredential]::new('', $adminSecurePassword)
    $env:ADMIN_BOOTSTRAP_PASSWORD = $adminCredential.Password
}
try {
    dotnet run --project (Join-Path $PSScriptRoot 'AccountAdmin.csproj') --no-launch-profile
} finally {
    Remove-Item Env:ADMIN_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
    $adminCredential = $null
    $adminSecurePassword = $null
}
