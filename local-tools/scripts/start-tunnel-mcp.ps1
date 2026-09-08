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

$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) ".env.local"
if (Test-Path $envFile) {
    $approvalModeConfigured = $false
    $approvalMode = $null
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*CODEX_PLUS_MCP_APPROVAL_MODE\s*=\s*(.*?)\s*$') {
            $approvalModeConfigured = $true
            $approvalMode = $Matches[1].Trim()
            if ($approvalMode.Length -ge 2 -and (($approvalMode.StartsWith('"') -and $approvalMode.EndsWith('"')) -or ($approvalMode.StartsWith("'") -and $approvalMode.EndsWith("'")))) {
                $approvalMode = $approvalMode.Substring(1, $approvalMode.Length - 2)
            }
        }
    }
    if ($approvalModeConfigured) {
        if ($approvalMode) {
            [Environment]::SetEnvironmentVariable("CODEX_PLUS_MCP_APPROVAL_MODE", $approvalMode, "Process")
        } else {
            [Environment]::SetEnvironmentVariable("CODEX_PLUS_MCP_APPROVAL_MODE", $null, "Process")
        }
    }
}

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
