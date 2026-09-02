[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$installRoot = Join-Path $projectRoot ".tools\tunnel-client"
$clientPath = Join-Path $installRoot "tunnel-client.exe"

if (Test-Path -LiteralPath $clientPath -PathType Leaf) {
    & $clientPath -v
    exit $LASTEXITCODE
}

$architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
$headers = @{ "User-Agent" = "codex-chat-local-tools" }
$release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/openai/tunnel-client/releases/latest"
$assetName = "tunnel-client-$($release.tag_name)-windows-$architecture.zip"
$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
if (-not $asset) {
    throw "The latest OpenAI tunnel-client release does not include $assetName."
}

$agentsRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ".agents"))
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path $agentsRoot "codex-chat-local-tools-tunnel-install"))
if (-not $temporaryRoot.StartsWith($agentsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a temporary directory outside $agentsRoot."
}

New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
$archivePath = Join-Path $temporaryRoot $assetName
$expandedPath = Join-Path $temporaryRoot "expanded"

try {
    Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedPath
    New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
    Copy-Item -Path (Join-Path $expandedPath "*") -Destination $installRoot -Recurse -Force
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}

if (-not (Test-Path -LiteralPath $clientPath -PathType Leaf)) {
    throw "The archive did not contain tunnel-client.exe."
}

& $clientPath -v
exit $LASTEXITCODE
