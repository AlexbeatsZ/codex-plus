[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot "dist\host-rpc.js"
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "dist\host-rpc.js is missing. Run npm install and npm run build first."
}

if (-not $env:CODEX_PLUS_RG) {
    $codexPackage = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($codexPackage) {
        $bundledRipgrep = Join-Path $codexPackage.InstallLocation "app\resources\rg.exe"
        if (Test-Path -LiteralPath $bundledRipgrep -PathType Leaf) {
            [Environment]::SetEnvironmentVariable("CODEX_PLUS_RG", $bundledRipgrep, "Process")
        }
    }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $nodePath = $nodeCommand.Source
} else {
    $nodeCandidates = @(
        (Join-Path $env:USERPROFILE "scoop\apps\nodejs-lts\current\node.exe"),
        (Join-Path $env:USERPROFILE "scoop\apps\nodejs\current\node.exe"),
        (Join-Path $env:ProgramFiles "nodejs\node.exe")
    )
    $nodePath = $nodeCandidates |
        Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
        Select-Object -First 1
    if (-not $nodePath) {
        $nodePath = Get-ChildItem -Path (Join-Path $env:USERPROFILE "scoop\apps\nodejs-lts\*\node.exe") -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $nodePath) {
        $nodePath = Get-ChildItem -Path (Join-Path $env:USERPROFILE "scoop\apps\nodejs\*\node.exe") -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
}
if (-not $nodePath) {
    throw "node is required for host-rpc"
}

& $nodePath $entryPoint --root $Root
exit $LASTEXITCODE