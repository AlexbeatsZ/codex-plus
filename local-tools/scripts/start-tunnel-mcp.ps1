[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Root,

    [string]$CodexHome,

    [string[]]$SkillRoot,

    [switch]$NoCodexContext
)

$ErrorActionPreference = "Stop"

# tunnel-client needs the runtime key, but the MCP child does not.
[Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $null, "Process")
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $null, "Process")
[Environment]::SetEnvironmentVariable("HTTPS_PROXY", $null, "Process")

$startArguments = @{
    Root = $Root
    Stdio = $true
}
if ($CodexHome) {
    $startArguments.CodexHome = $CodexHome
}
if ($SkillRoot) {
    $startArguments.SkillRoot = $SkillRoot
}
if ($NoCodexContext) {
    $startArguments.NoCodexContext = $true
}

& (Join-Path $PSScriptRoot "start.ps1") @startArguments
exit $LASTEXITCODE
