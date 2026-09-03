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

& node @arguments
exit $LASTEXITCODE
