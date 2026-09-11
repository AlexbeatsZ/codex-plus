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

function Get-LocalEnvValue {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Lines,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    foreach ($line in $Lines) {
        if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*?)\s*$')) {
            $value = $Matches[1].Trim()
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $null
}

$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) ".env.local"
if (Test-Path $envFile) {
    $envLines = @(Get-Content $envFile)
    foreach ($key in @("CODEX_PLUS_MCP_APPROVAL_MODE", "CODEX_PLUS_MACHINE_ID", "CODEX_PLUS_NODE")) {
        $value = Get-LocalEnvValue -Lines $envLines -Name $key
        if ($value) {
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
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
