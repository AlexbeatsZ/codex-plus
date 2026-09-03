$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $projectRoot ".tools\tunnel-client\tunnel-client.exe"
$envFile = Join-Path $projectRoot ".env.local"
$tunnelArguments = @($args)

if (-not (Test-Path -LiteralPath $clientPath -PathType Leaf)) {
    throw "tunnel-client.exe is missing. Run .\scripts\install-tunnel-client.ps1 first."
}
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw ".env.local is missing. Configure OPENAI_API_KEY before running tunnel-client."
}

$keyLine = Get-Content -LiteralPath $envFile |
    Where-Object { $_ -match "^\s*OPENAI_API_KEY\s*=" } |
    Select-Object -Last 1
if (-not $keyLine) {
    throw "OPENAI_API_KEY is missing from .env.local."
}

$apiKey = ($keyLine -split "=", 2)[1].Trim()
if (($apiKey.StartsWith('"') -and $apiKey.EndsWith('"')) -or
    ($apiKey.StartsWith("'") -and $apiKey.EndsWith("'"))) {
    $apiKey = $apiKey.Substring(1, $apiKey.Length - 2)
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "OPENAI_API_KEY in .env.local is empty."
}

$proxyLine = Get-Content -LiteralPath $envFile |
    Where-Object { $_ -match "^\s*TUNNEL_HTTP_PROXY\s*=" } |
    Select-Object -Last 1
$tunnelHttpProxy = $null
if ($proxyLine) {
    $tunnelHttpProxy = ($proxyLine -split "=", 2)[1].Trim()
    if (($tunnelHttpProxy.StartsWith('"') -and $tunnelHttpProxy.EndsWith('"')) -or
        ($tunnelHttpProxy.StartsWith("'") -and $tunnelHttpProxy.EndsWith("'"))) {
        $tunnelHttpProxy = $tunnelHttpProxy.Substring(1, $tunnelHttpProxy.Length - 2)
    }
}

$previousControlPlaneKey = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "Process")
$previousOpenAIKey = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "Process")
$previousHttpsProxy = [Environment]::GetEnvironmentVariable("HTTPS_PROXY", "Process")
$exitCode = 1
Push-Location -LiteralPath $projectRoot
try {
    [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $apiKey, "Process")
    [Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $null, "Process")
    if (-not [string]::IsNullOrWhiteSpace($tunnelHttpProxy)) {
        [Environment]::SetEnvironmentVariable("HTTPS_PROXY", $tunnelHttpProxy, "Process")
    }
    & $clientPath @tunnelArguments
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
    [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $previousControlPlaneKey, "Process")
    [Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $previousOpenAIKey, "Process")
    [Environment]::SetEnvironmentVariable("HTTPS_PROXY", $previousHttpsProxy, "Process")
}

exit $exitCode
