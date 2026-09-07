[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Root,

    [string]$HostAddress = "127.0.0.1",

    [ValidateRange(1, 65535)]
    [int]$Port = 3344,

    [string]$CodexHome,

    [string[]]$SkillRoot,

    [switch]$NoCodexContext,

    [switch]$Stdio
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot "dist\cli.js"

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "dist\cli.js is missing. Run npm install and npm run build first."
}

$nodeCommand = $null
if ($env:CODEX_PLUS_NODE -and (Test-Path -LiteralPath $env:CODEX_PLUS_NODE -PathType Leaf)) {
    $nodeCommand = $env:CODEX_PLUS_NODE
}
if (-not $nodeCommand) {
    $resolvedNode = Get-Command node -ErrorAction SilentlyContinue
    if ($resolvedNode) {
        $nodeCommand = $resolvedNode.Source
    }
}
if (-not $nodeCommand) {
    $nodeCandidates = @()
    if ($env:LOCALAPPDATA) {
        $localAppData = [Environment]::ExpandEnvironmentVariables($env:LOCALAPPDATA)
        $nodeCandidates += (Join-Path $localAppData "OpenAI\Codex\bin\node.exe")
    }
    if ($env:USERPROFILE) {
        $nodeCandidates += (Join-Path $env:USERPROFILE "scoop\apps\nodejs-lts\current\node.exe")
        $nodeCandidates += (Join-Path $env:USERPROFILE "scoop\apps\nodejs\current\node.exe")
    }
    if ($env:ProgramFiles) {
        $nodeCandidates += (Join-Path $env:ProgramFiles "nodejs\node.exe")
    }
    $codexPackage = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($codexPackage) {
        $nodeCandidates += (Join-Path $codexPackage.InstallLocation "app\resources\cua_node\bin\node.exe")
    }
    $nodeCommand = $nodeCandidates |
        Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
        Select-Object -First 1
}
if (-not $nodeCommand) {
    throw "node is required"
}

$arguments = @($entryPoint)
foreach ($workspaceRoot in $Root) {
    $arguments += @("--root", $workspaceRoot)
}
if ($CodexHome) {
    $arguments += @("--codex-home", $CodexHome)
}
foreach ($extraSkillRoot in $SkillRoot) {
    $arguments += @("--skill-root", $extraSkillRoot)
}
if ($NoCodexContext) {
    $arguments += "--no-codex-context"
}

if ($Stdio) {
    $arguments += "--stdio"
} else {
    $arguments += @("--host", $HostAddress, "--port", $Port)
}

& $nodeCommand @arguments
exit $LASTEXITCODE
