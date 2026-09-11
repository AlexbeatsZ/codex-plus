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
    $forwardedKeys = @("CODEX_PLUS_MCP_APPROVAL_MODE", "CODEX_PLUS_MACHINE_ID")
    $forwardedValues = @{}
    foreach ($line in Get-Content $envFile) {
        foreach ($key in $forwardedKeys) {
            if ($line -match ('^\s*' + [regex]::Escape($key) + '\s*=\s*(.*?)\s*
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
)) {
                $value = $Matches[1].Trim()
                if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                    $value = $value.Substring(1, $value.Length - 2)
                }
                $forwardedValues[$key] = $value
            }
        }
    }
    foreach ($key in $forwardedKeys) {
        if ($forwardedValues.ContainsKey($key) -and $forwardedValues[$key]) {
            [Environment]::SetEnvironmentVariable($key, $forwardedValues[$key], "Process")
        } else {
            [Environment]::SetEnvironmentVariable($key, $null, "Process")
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
